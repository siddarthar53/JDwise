"""Keeps the knowledge base in sync with the application database.

* On startup: role library + style guide, then every JD and chat message.
* Incrementally: the API calls /index/jd and /index/message on every change
  (approval in particular), so new approved JDs are searchable within seconds.
"""
from __future__ import annotations

import time
from typing import Any, Optional

from . import knowledge, services
from .rag.store import jd_to_chunks, library_chunks, message_chunk, style_chunks


def seed_static() -> int:
    kb = services.get_kb()
    n = 0
    for item in knowledge.role_library():
        n += kb.upsert_doc(item["id"], library_chunks([item]))
    n += kb.upsert_doc("style-guide", style_chunks(knowledge.style_guide()))
    return n


def jd_doc_from_mongo(jd: dict) -> dict:
    approved_at = ""
    for h in jd.get("history") or []:
        if h.get("action") == "hr_approved":
            approved_at = str(h.get("at"))
    return {**jd, "_id": str(jd["_id"]), "createdBy": str(jd.get("createdBy")), "approvedAt": approved_at}


def index_jd(jd: dict) -> dict:
    doc = jd_doc_from_mongo(jd) if "_id" in jd else {**jd, "_id": str(jd.get("id"))}
    t0 = time.time()
    n = services.get_kb().upsert_doc(doc["_id"], jd_to_chunks(doc))
    return {"chunks": n, "ms": round((time.time() - t0) * 1000, 1)}


def sync_from_db() -> dict:
    db = services.get_db()
    stats: dict[str, Any] = {"static": seed_static(), "jds": 0, "messages": 0}
    if db is None:
        return stats
    services.get_kb().clear(["jd", "message"])  # drop chunks of deleted JDs / conversations
    for jd in db["jobdescriptions"].find({}):
        index_jd(jd)
        stats["jds"] += 1
    users = {str(u["_id"]): u.get("name", "") for u in db["users"].find({}, {"name": 1})}
    convs = {str(c["_id"]): c for c in db["conversations"].find({})}
    kb = services.get_kb()
    by_conv: dict[str, list] = {}
    for m in db["messages"].find({}):
        cid = str(m["conversation"])
        conv = convs.get(cid)
        if not conv:
            continue
        parts = [str(p) for p in conv.get("participants", [])]
        by_conv.setdefault(cid, []).append(message_chunk({
            "id": str(m["_id"]), "conversation_id": cid, "participants": parts,
            "participant_names": [users.get(p, "") for p in parts], "sender_name": users.get(str(m["sender"]), ""),
            "content": m.get("content", ""), "at": m.get("createdAt"),
        }))
    for cid, chunks in by_conv.items():
        kb.upsert_doc(f"conv:{cid}", chunks)
        stats["messages"] += len(chunks)
    return stats


def index_message(msg: dict) -> int:
    """Append one message to its conversation document."""
    kb = services.get_kb()
    doc_id = f"conv:{msg['conversation_id']}"
    existing = [c for c in kb.index().chunks if c["doc_id"] == doc_id]
    chunks = [{k: v for k, v in c.items() if k not in ("vector", "embedder", "indexed_at")} for c in existing]
    chunks = [c for c in chunks if c["id"] != f"msg:{msg['id']}"] + [message_chunk(msg)]
    return kb.upsert_doc(doc_id, chunks)
