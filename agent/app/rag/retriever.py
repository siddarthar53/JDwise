"""Hybrid retrieval: BM25 + dense vectors fused with Reciprocal Rank Fusion,
then a metadata-aware reranker. Mode/reranker/k are configurable so the eval
harness can run ablations (vector-only vs hybrid, reranker on/off, k=3/5/10)."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Optional

import numpy as np

from ..config import settings
from .embed import get_embedder, tokenize, _STOP
from .store import KnowledgeBase

LEVEL_ORDER = ["intern", "junior", "mid", "senior", "lead", "staff", "manager", "principal", "director"]


@dataclass
class Filters:
    doc_types: Optional[list[str]] = None          # e.g. ["jd", "library"]
    statuses: Optional[list[str]] = None           # e.g. ["approved"]
    allowed_doc_ids: Optional[set[str]] = None     # permission filter (Q&A)
    allowed_conversations: Optional[set[str]] = None
    exclude_doc_ids: set[str] = field(default_factory=set)
    sections: Optional[list[str]] = None

    def ok(self, c: dict) -> bool:
        if self.doc_types and c["doc_type"] not in self.doc_types:
            return False
        if c["doc_id"] in self.exclude_doc_ids:
            return False
        if self.sections and c.get("section") not in self.sections:
            return False
        meta = c.get("meta") or {}
        if self.statuses and c["doc_type"] in ("jd",) and meta.get("status") not in self.statuses:
            return False
        if c["doc_type"] == "message":
            if self.allowed_conversations is not None and meta.get("conversation_id") not in self.allowed_conversations:
                return False
        elif c["doc_type"] == "jd" and self.allowed_doc_ids is not None and c["doc_id"] not in self.allowed_doc_ids:
            return False
        return True


def _level_affinity(a: str, b: str) -> float:
    if not a or not b:
        return 0.0
    if a == b:
        return 1.0
    try:
        return max(0.0, 1.0 - abs(LEVEL_ORDER.index(a) - LEVEL_ORDER.index(b)) / 3)
    except ValueError:
        return 0.0


class Retriever:
    def __init__(self, kb: KnowledgeBase):
        self.kb = kb

    def search(
        self,
        query: str,
        k: Optional[int] = None,
        filters: Optional[Filters] = None,
        mode: Optional[str] = None,
        rerank: Optional[bool] = None,
        query_meta: Optional[dict[str, Any]] = None,
        min_score: float = 0.0,
    ) -> list[dict]:
        k = k or settings.retrieval_k
        mode = mode or settings.retrieval_mode
        rerank = settings.use_reranker if rerank is None else rerank
        filters = filters or Filters()
        query_meta = query_meta or {}
        idx = self.kb.index()
        if not idx.chunks or not query.strip():
            return []
        cand = [i for i, c in enumerate(idx.chunks) if filters.ok(c)]
        if not cand:
            return []

        bm = idx.bm25.scores(query) if mode in ("hybrid", "bm25") else [0.0] * len(idx.chunks)
        if mode in ("hybrid", "vector"):
            qv = get_embedder().embed([query])[0]
            dense = idx.matrix @ qv
        else:
            dense = np.zeros(len(idx.chunks))

        def ranks(scores) -> dict[int, int]:
            order = sorted(cand, key=lambda i: -scores[i])
            return {i: r for r, i in enumerate(order)}

        rrf: dict[int, float] = {i: 0.0 for i in cand}
        if mode in ("hybrid", "bm25"):
            for i, r in ranks(bm).items():
                if bm[i] > 0:
                    rrf[i] += 1.0 / (60 + r)
        if mode in ("hybrid", "vector"):
            for i, r in ranks(dense).items():
                rrf[i] += 1.0 / (60 + r)

        pool = sorted(cand, key=lambda i: -rrf[i])[: max(k * 4, 20)]
        qtok = set(t for t in tokenize(query) if t not in _STOP)
        results = []
        max_rrf = max((rrf[i] for i in pool), default=1.0) or 1.0
        for i in pool:
            c = idx.chunks[i]
            final = rrf[i] / max_rrf
            parts = {"bm25": round(float(bm[i]), 4), "dense": round(float(dense[i]), 4), "rrf": round(rrf[i], 5)}
            if rerank:
                ctok = set(t for t in tokenize(c["title"] + " " + c["text"]) if t not in _STOP)
                overlap = len(qtok & ctok) / (len(qtok) or 1)
                ttok = set(tokenize(c["title"]))
                title_ov = len(qtok & ttok) / (len(ttok) or 1)
                meta = c.get("meta") or {}
                aff = 0.0
                if query_meta.get("level"):
                    aff += 0.6 * _level_affinity(query_meta["level"], meta.get("level", ""))
                if query_meta.get("department") and meta.get("department"):
                    aff += 0.4 * (1.0 if query_meta["department"].lower() == meta["department"].lower() else 0.0)
                pref = 0.15 if query_meta.get("section") and c.get("section") == query_meta["section"] else 0.0
                final = 0.45 * final + 0.25 * overlap + 0.1 * title_ov + 0.2 * aff + pref
                parts.update(overlap=round(overlap, 3), affinity=round(aff, 3))
            parts["final"] = round(final, 4)
            # absolute relevance (independent of the rest of the pool) for refusal thresholds
            parts["relevance"] = round(float(max(dense[i], 0.0)) * 0.6 + min(float(bm[i]) / 10.0, 1.0) * 0.4, 4)
            results.append({"chunk": c, "score": final, "scores": parts})
        results.sort(key=lambda r: -r["score"])
        results = [r for r in results if r["scores"]["relevance"] >= min_score]
        return results[:k]

    def similar_docs(self, query: str, k: int = 3, filters: Optional[Filters] = None, query_meta=None) -> list[dict]:
        """Aggregate chunk hits to document level."""
        hits = self.search(query, k=max(k * 8, 24), filters=filters, query_meta=query_meta)
        docs: dict[str, dict] = {}
        for h in hits:
            c = h["chunk"]
            d = docs.setdefault(c["doc_id"], {"doc_id": c["doc_id"], "title": c["title"], "doc_type": c["doc_type"],
                                               "meta": c.get("meta", {}), "score": 0.0, "chunks": []})
            d["score"] = max(d["score"], h["score"]) + 0.05 * len(d["chunks"])
            d["chunks"].append(h)
        return sorted(docs.values(), key=lambda d: -d["score"])[:k]
