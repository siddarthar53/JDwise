"""Chunk store + section-aware chunking.

Chunks live in MongoDB (`kb_chunks`) so they survive restarts and are shared by
workers; an in-process index (dense matrix + BM25) is rebuilt lazily whenever
the collection version changes. A pure in-memory backend is used by tests and
the offline eval harness.
"""
from __future__ import annotations

import re
import threading
import time
from typing import Any, Iterable, Optional

import numpy as np

from .bm25 import BM25
from .embed import get_embedder


# --------------------------------------------------------------------------- chunking

def _s(v: Any) -> str:
    return str(v) if v is not None else ""


def jd_to_chunks(jd: dict, strategy: str = "bullet") -> list[dict]:
    """Section-aware chunking of a JD. strategy='bullet' gives one chunk per
    responsibility/qualification bullet (precise citations); 'section' gives
    one chunk per section; 'fixed' splits the flattened text into ~60-word windows
    (used only as an ablation baseline)."""
    doc_id = _s(jd.get("_id") or jd.get("id"))
    title = _s(jd.get("title"))
    meta = {
        "department": _s(jd.get("department")),
        "level": _s(jd.get("level")),
        "status": _s(jd.get("status") or "approved"),
        "created_by": _s(jd.get("createdBy")),
        "approved_at": _s(jd.get("approvedAt") or ""),
        "skills": [s for s in (jd.get("skills") or [])],
    }
    doc_type = jd.get("_doc_type", "jd")
    base = {"doc_id": doc_id, "doc_type": doc_type, "title": title, "meta": meta}
    chunks: list[dict] = []

    def add(section: str, text: str, idx: int = 0):
        text = text.strip()
        if not text:
            return
        chunks.append({**base, "id": f"{doc_id}:{section}:{idx}", "section": section, "text": text})

    if strategy == "fixed":
        flat = " ".join([title, _s(jd.get("summary"))] + list(jd.get("responsibilities") or []) + list(jd.get("qualifications") or []) + list(jd.get("skills") or []))
        words = flat.split()
        for i in range(0, len(words), 60):
            add("fixed", " ".join(words[i:i + 60]), i // 60)
        return chunks

    add("summary", f"{title} ({meta['department']}, {meta['level']}). {_s(jd.get('summary'))}")
    for sec in ("responsibilities", "qualifications"):
        items = [x for x in (jd.get(sec) or []) if _s(x).strip()]
        if strategy == "section":
            add(sec, f"{title} — {sec}: " + "; ".join(items))
        else:
            for i, it in enumerate(items):
                add(sec, _s(it), i)
    if jd.get("skills"):
        add("skills", f"{title} skills: " + ", ".join(jd["skills"]))
    # discussion: reviewer comments and peer feedback (Q&A over "what did HR object to")
    disc = []
    for h in jd.get("history") or []:
        if h.get("comment"):
            disc.append(f"{h.get('action')}: {h.get('comment')}")
    for p in jd.get("peerApprovals") or []:
        if p.get("comment"):
            disc.append(f"peer {p.get('status')}: {p.get('comment')}")
    for i, d in enumerate(disc):
        add("discussion", f"{title} — {d}", i)
    return chunks


def library_chunks(items: Iterable[dict], strategy: str = "bullet") -> list[dict]:
    out = []
    for it in items:
        d = dict(it)
        d["_id"] = it["id"]
        d["status"] = "approved"
        d["_doc_type"] = "library"
        out.extend(jd_to_chunks(d, strategy))
    return out


def style_chunks(md: str) -> list[dict]:
    out = []
    for i, part in enumerate(re.split(r"\n(?=## )", md)):
        part = part.strip()
        if not part or part.startswith("# "):
            continue
        heading = part.splitlines()[0].lstrip("# ").strip()
        out.append({"id": f"style:{i}", "doc_id": "style-guide", "doc_type": "style", "title": "Style guide: " + heading,
                    "section": "style", "text": part, "meta": {"status": "approved"}})
    return out


def message_chunk(msg: dict) -> dict:
    return {
        "id": f"msg:{msg['id']}", "doc_id": f"conv:{msg['conversation_id']}", "doc_type": "message",
        "title": f"Chat with {', '.join(msg.get('participant_names') or [])}".strip(),
        "section": "message", "text": f"{msg.get('sender_name', '')}: {msg.get('content', '')}",
        "meta": {"conversation_id": str(msg["conversation_id"]), "participants": [str(p) for p in msg.get("participants", [])],
                 "at": str(msg.get("at", ""))},
    }


# --------------------------------------------------------------------------- store

class _Index:
    def __init__(self, chunks: list[dict]):
        self.chunks = chunks
        self.texts = [f"{c.get('title', '')}. {c['text']}" for c in chunks]
        self.bm25 = BM25(self.texts)
        self.matrix = np.zeros((0, 1), dtype=np.float32)
        if chunks:
            vecs = [c.get("vector") for c in chunks]
            if all(v is not None for v in vecs):
                self.matrix = np.asarray(vecs, dtype=np.float32)
            else:
                self.matrix = get_embedder().embed(self.texts)


class KnowledgeBase:
    def __init__(self, db=None):
        self._db = db
        self._mem: dict[str, dict] = {}
        self._version = 0
        self._index: Optional[_Index] = None
        self._index_version = -1
        self._lock = threading.RLock()

    # --- backend helpers
    @property
    def _col(self):
        return self._db["kb_chunks"] if self._db is not None else None

    def _bump(self) -> None:
        self._version += 1
        if self._db is not None:
            self._db["kb_meta"].update_one({"_id": "version"}, {"$inc": {"v": 1}, "$set": {"at": time.time()}}, upsert=True)

    def _remote_version(self) -> int:
        if self._db is None:
            return self._version
        doc = self._db["kb_meta"].find_one({"_id": "version"})
        return int(doc["v"]) if doc else 0

    # --- writes
    def upsert_doc(self, doc_id: str, chunks: list[dict]) -> int:
        emb = get_embedder()
        if chunks:
            vecs = emb.embed([f"{c.get('title', '')}. {c['text']}" for c in chunks])
            now = time.time()
            for c, v in zip(chunks, vecs):
                c["vector"] = v.tolist()
                c["embedder"] = emb.name
                c["indexed_at"] = now
        with self._lock:
            if self._col is not None:
                self._col.delete_many({"doc_id": doc_id})
                if chunks:
                    self._col.insert_many([{**c, "_id": c["id"]} for c in chunks])
            else:
                for k in [k for k, c in self._mem.items() if c["doc_id"] == doc_id]:
                    del self._mem[k]
                for c in chunks:
                    self._mem[c["id"]] = c
            self._bump()
        return len(chunks)

    def delete_doc(self, doc_id: str) -> None:
        self.upsert_doc(doc_id, [])

    def clear(self, doc_types: Optional[list[str]] = None) -> None:
        with self._lock:
            q = {"doc_type": {"$in": doc_types}} if doc_types else {}
            if self._col is not None:
                self._col.delete_many(q)
            else:
                for k in [k for k, c in self._mem.items() if not doc_types or c["doc_type"] in doc_types]:
                    del self._mem[k]
            self._bump()

    # --- reads
    def index(self) -> _Index:
        with self._lock:
            v = self._remote_version()
            if self._index is None or v != self._index_version:
                if self._col is not None:
                    chunks = list(self._col.find({}, {"_id": 0}))
                    emb = get_embedder().name
                    if any(c.get("embedder") != emb for c in chunks):
                        for c in chunks:
                            c.pop("vector", None)
                else:
                    chunks = list(self._mem.values())
                self._index = _Index(chunks)
                self._index_version = v
            return self._index

    def count(self) -> int:
        return len(self.index().chunks)

    def get_chunk(self, chunk_id: str) -> Optional[dict]:
        for c in self.index().chunks:
            if c["id"] == chunk_id:
                return c
        return None
