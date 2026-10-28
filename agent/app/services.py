"""Process-wide singletons (DB handle, knowledge base, retriever)."""
from __future__ import annotations

from typing import Optional

from .rag.retriever import Retriever
from .rag.store import KnowledgeBase

_db = None
kb: KnowledgeBase = KnowledgeBase()
retriever: Retriever = Retriever(kb)


def init(db=None) -> None:
    global _db, kb, retriever
    _db = db
    kb = KnowledgeBase(db)
    retriever = Retriever(kb)


def db():
    return _db


def use_memory_kb() -> KnowledgeBase:
    """Tests/evals: swap in a fresh in-memory knowledge base."""
    global kb, retriever
    kb = KnowledgeBase(None)
    retriever = Retriever(kb)
    return kb


def get_kb() -> KnowledgeBase:
    return kb


def get_retriever() -> Retriever:
    return retriever


def get_db() -> Optional[object]:
    return _db
