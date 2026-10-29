"""Embeddings.

Default: a deterministic feature-hashing embedder (word unigrams + bigrams +
character trigrams, sublinear TF, signed hashing, L2-normalised). It needs no
network or API key, so the whole system and the eval suite run offline.
Set EMBEDDINGS_PROVIDER=voyage (+ VOYAGE_API_KEY) or openrouter
(+ OPENROUTER_API_KEY, EMBEDDINGS_MODEL) to use a neural embedding model instead; the store records which embedder produced each vector and
re-embeds on mismatch.
"""
from __future__ import annotations

import hashlib
import math
import re
from typing import Sequence

import numpy as np

from ..config import settings

DIM = 768
_WORD = re.compile(r"[a-z0-9+#.]+")
_STOP = set("a an the and or of to in for with on at by as is are be you your we our will this that from it its into".split())


def tokenize(text: str) -> list[str]:
    return [w.strip(".") for w in _WORD.findall((text or "").lower()) if w.strip(".")]


def _h(s: str) -> tuple[int, float]:
    d = hashlib.blake2b(s.encode(), digest_size=8).digest()
    v = int.from_bytes(d, "little")
    return v % DIM, (1.0 if (v >> 63) & 1 else -1.0)


class HashingEmbedder:
    name = "hashing-v1"

    def embed(self, texts: Sequence[str]) -> np.ndarray:
        out = np.zeros((len(texts), DIM), dtype=np.float32)
        for i, t in enumerate(texts):
            toks = [w for w in tokenize(t) if w not in _STOP]
            feats: dict[str, float] = {}
            for w in toks:
                feats["w:" + w] = feats.get("w:" + w, 0) + 1.0
                if len(w) > 3:
                    for j in range(len(w) - 2):
                        g = "c:" + w[j:j + 3]
                        feats[g] = feats.get(g, 0) + 0.25
            for a, b in zip(toks, toks[1:]):
                k = f"b:{a}_{b}"
                feats[k] = feats.get(k, 0) + 0.75
            for f, tf in feats.items():
                idx, sign = _h(f)
                out[i, idx] += sign * (1.0 + math.log(tf)) if tf >= 1 else sign * tf
            n = np.linalg.norm(out[i])
            if n > 0:
                out[i] /= n
        return out


class VoyageEmbedder:
    name = "voyage-3"

    def embed(self, texts: Sequence[str]) -> np.ndarray:
        import httpx

        vecs: list[list[float]] = []
        for start in range(0, len(texts), 64):
            batch = list(texts[start:start + 64])
            r = httpx.post(
                "https://api.voyageai.com/v1/embeddings",
                headers={"Authorization": f"Bearer {settings.voyage_api_key}"},
                json={"input": batch, "model": "voyage-3"},
                timeout=30,
            )
            r.raise_for_status()
            vecs.extend(d["embedding"] for d in r.json()["data"])
        arr = np.asarray(vecs, dtype=np.float32)
        arr /= np.linalg.norm(arr, axis=1, keepdims=True) + 1e-9
        return arr


class OpenRouterEmbedder:
    """OpenRouter's OpenAI-compatible /embeddings endpoint (EMBEDDINGS_MODEL)."""

    def __init__(self):
        self.model = settings.embeddings_model
        self.name = f"openrouter:{self.model}"

    def embed(self, texts: Sequence[str]) -> np.ndarray:
        import httpx

        vecs: list[list[float]] = []
        for start in range(0, len(texts), 64):
            batch = list(texts[start:start + 64])
            r = httpx.post(
                f"{settings.openrouter_base_url.rstrip('/')}/embeddings",
                headers={"Authorization": f"Bearer {settings.openrouter_api_key}"},
                json={"input": batch, "model": self.model},
                timeout=60,
            )
            r.raise_for_status()
            data = r.json()
            if data.get("error") or "data" not in data:
                raise RuntimeError(f"openrouter embeddings: {data.get('error')}")
            vecs.extend(d["embedding"] for d in sorted(data["data"], key=lambda d: d.get("index", 0)))
        arr = np.asarray(vecs, dtype=np.float32)
        arr /= np.linalg.norm(arr, axis=1, keepdims=True) + 1e-9
        return arr


_embedder = None


def get_embedder():
    global _embedder
    if _embedder is None:
        if settings.embeddings_provider == "openrouter" and settings.openrouter_api_key:
            _embedder = OpenRouterEmbedder()
        elif settings.embeddings_provider == "voyage" and settings.voyage_api_key:
            _embedder = VoyageEmbedder()
        else:
            _embedder = HashingEmbedder()
    return _embedder
