"""Okapi BM25 over the chunk corpus (exact-term recall for skills like "Go", "K8s")."""
from __future__ import annotations

import math
from collections import Counter

from .embed import tokenize, _STOP


class BM25:
    def __init__(self, docs: list[str], k1: float = 1.4, b: float = 0.75):
        self.k1, self.b = k1, b
        self.docs = [[t for t in tokenize(d) if t not in _STOP] for d in docs]
        self.n = len(self.docs)
        self.avgdl = (sum(len(d) for d in self.docs) / self.n) if self.n else 0.0
        self.tf = [Counter(d) for d in self.docs]
        df: Counter = Counter()
        for d in self.docs:
            df.update(set(d))
        self.idf = {t: math.log(1 + (self.n - f + 0.5) / (f + 0.5)) for t, f in df.items()}

    def scores(self, query: str) -> list[float]:
        q = [t for t in tokenize(query) if t not in _STOP]
        out = [0.0] * self.n
        for i, tf in enumerate(self.tf):
            dl = len(self.docs[i]) or 1
            s = 0.0
            for t in q:
                f = tf.get(t)
                if not f:
                    continue
                s += self.idf.get(t, 0.0) * f * (self.k1 + 1) / (f + self.k1 * (1 - self.b + self.b * dl / (self.avgdl or 1)))
            out[i] = s
        return out
