"""FastAPI entrypoint for the JDFlow agent service.

Only the Express API talks to this service (HMAC-signed requests); browsers
never call it directly. Agents can *propose* content; they have no endpoint or
tool that changes a JD's approval status.
"""
from __future__ import annotations

import logging
import threading
from contextlib import asynccontextmanager
from typing import Any, Optional

from fastapi import Depends, FastAPI, HTTPException
from pydantic import BaseModel, Field

from . import indexer, runs, services
from .agents import critic, ops, qa, reviewer, reviser
from .config import settings
from .security import verify

log = logging.getLogger("agent")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
_ready = {"kb": False, "db": False, "sync": None}


def _connect_db():
    try:
        from pymongo import MongoClient

        client = MongoClient(settings.mongodb_uri, serverSelectionTimeoutMS=3000)
        client.admin.command("ping")
        db = client.get_default_database()
        _ready["db"] = True
        return db
    except Exception as e:  # service still works (in-memory KB, no persistence)
        log.warning("MongoDB unavailable (%s); running with in-memory stores", e)
        return None


def _initial_sync():
    try:
        _ready["sync"] = indexer.sync_from_db()
        _ready["kb"] = True
        log.info("knowledge base synced: %s", _ready["sync"])
    except Exception as e:
        log.exception("initial sync failed: %s", e)


@asynccontextmanager
async def lifespan(app: FastAPI):
    services.init(_connect_db())
    threading.Thread(target=_initial_sync, daemon=True).start()
    yield


app = FastAPI(title="JDFlow agent service", version="1.0.0", lifespan=lifespan)
signed = [Depends(verify)]


@app.get("/health")
def health() -> dict:
    return {"ok": True, "service": "jd-agent", "provider": "anthropic" if settings.use_llm else "heuristic",
            "db": _ready["db"], "kb_ready": _ready["kb"], "prompt_version": settings.prompt_version}


# --------------------------------------------------------------------------- drafting

class MessageIn(BaseModel):
    message: str = Field(min_length=1, max_length=20000)
    idempotency_key: str = ""
    user_hash: str = ""
    context: dict[str, Any] = Field(default_factory=dict)


@app.post("/threads/{thread_id}/messages", dependencies=signed)
def post_message(thread_id: str, body: MessageIn) -> dict:
    run = runs.start_draft_run(thread_id, body.message, body.context, body.user_hash, body.idempotency_key)
    return {"run_id": run["_id"], "status": run["status"]}


@app.get("/runs/{run_id}", dependencies=signed)
def get_run(run_id: str) -> dict:
    run = runs.get(run_id)
    if not run:
        raise HTTPException(404, "run not found")
    return run


@app.get("/threads/{thread_id}/state", dependencies=signed)
def get_thread_state(thread_id: str) -> dict:
    return runs.thread_state(thread_id)


@app.delete("/threads/{thread_id}", dependencies=signed)
def delete_thread(thread_id: str) -> dict:
    runs.reset_thread(thread_id)
    return {"ok": True}


# --------------------------------------------------------------------------- critic / reviewer / reviser

class JDIn(BaseModel):
    jd: dict[str, Any]
    previous: Optional[dict[str, Any]] = None
    stage: str = ""
    comment: str = ""
    last_rejection: Optional[str] = None
    user_hash: str = ""


@app.post("/critique", dependencies=signed)
def post_critique(body: JDIn) -> dict:
    from .schemas import ToolCall
    from .tools import execute_many

    def go():
        jd = body.jd
        tools = execute_many([ToolCall(tool="get_salary_band", args={"department": jd.get("department", ""), "level": jd.get("level") or "mid",
                                                                     "location": jd.get("location") or "unknown", "title": jd.get("title", "")})], {}, node="reviewer")
        return critic.critique(jd, {}, tools)
    res, run = runs.run_sync("critique", go, thread_id=str(body.jd.get("_id", "")), user_hash=body.user_hash)
    return {"run_id": run["_id"], **res.model_dump()}


@app.post("/review", dependencies=signed)
def post_review(body: JDIn) -> dict:
    res, run = runs.run_sync("review", lambda: reviewer.review(body.jd, body.previous, body.stage, body.last_rejection),
                             thread_id=str(body.jd.get("_id", "")), user_hash=body.user_hash)
    return {"run_id": run["_id"], **res.model_dump()}


@app.post("/revise", dependencies=signed)
def post_revise(body: JDIn) -> dict:
    if not body.comment.strip():
        raise HTTPException(400, "comment required")
    def go():
        proposal, diff = reviser.revise(body.jd, body.comment)
        return {**proposal.model_dump(), "diff": diff}
    res, run = runs.run_sync("revise", go, thread_id=str(body.jd.get("_id", "")), user_hash=body.user_hash, input_preview=body.comment)
    return {"run_id": run["_id"], **res}


# --------------------------------------------------------------------------- Q&A / ops

class QAIn(BaseModel):
    question: str = Field(min_length=2, max_length=2000)
    allowed_jd_ids: list[str] = Field(default_factory=list)
    allowed_conversation_ids: list[str] = Field(default_factory=list)
    jd_index: list[dict[str, Any]] = Field(default_factory=list)
    user_hash: str = ""


@app.post("/qa", dependencies=signed)
def post_qa(body: QAIn) -> dict:
    res, run = runs.run_sync("qa", lambda: qa.answer(body.question, body.allowed_jd_ids, body.allowed_conversation_ids, body.jd_index),
                             user_hash=body.user_hash, input_preview=body.question)
    return {"run_id": run["_id"], **res.model_dump()}


class OpsIn(BaseModel):
    question: str = ""
    catalog: list[dict[str, Any]] = Field(default_factory=list)
    items: list[dict[str, Any]] = Field(default_factory=list)
    user_hash: str = ""


@app.post("/ops/route", dependencies=signed)
def post_ops_route(body: OpsIn) -> dict:
    if not body.catalog:
        raise HTTPException(400, "catalog required")
    res, run = runs.run_sync("ops_route", lambda: ops.route(body.question, body.catalog), user_hash=body.user_hash, input_preview=body.question)
    return {"run_id": run["_id"], **res.model_dump()}


@app.post("/ops/reminders", dependencies=signed)
def post_ops_reminders(body: OpsIn) -> dict:
    res, run = runs.run_sync("ops_reminders", lambda: ops.draft_reminders(body.items), user_hash=body.user_hash)
    return {"run_id": run["_id"], "drafts": res}


# --------------------------------------------------------------------------- indexing + metrics

class IndexJD(BaseModel):
    jd: dict[str, Any]


@app.post("/index/jd", dependencies=signed)
def post_index_jd(body: IndexJD) -> dict:
    jd = dict(body.jd)
    if "_id" not in jd and "id" in jd:
        jd["_id"] = jd["id"]
    return indexer.index_jd(jd)


@app.delete("/index/jd/{jd_id}", dependencies=signed)
def delete_index_jd(jd_id: str) -> dict:
    services.get_kb().delete_doc(jd_id)
    return {"ok": True}


class IndexMsg(BaseModel):
    message: dict[str, Any]


@app.post("/index/message", dependencies=signed)
def post_index_message(body: IndexMsg) -> dict:
    return {"chunks": indexer.index_message(body.message)}


@app.post("/index/sync", dependencies=signed)
def post_sync() -> dict:
    return indexer.sync_from_db()


@app.get("/metrics/summary", dependencies=signed)
def get_metrics(days: int = 30) -> dict:
    out = runs.metrics_summary(days)
    out["kb_chunks"] = services.get_kb().count()
    return out


@app.get("/runs", dependencies=signed)
def list_runs(limit: int = 30, kind: str = "") -> dict:
    col = services.get_db()["agent_runs"] if services.get_db() is not None else None
    q = {"kind": kind} if kind else {}
    if col is None:
        items = sorted(runs._mem_runs.values(), key=lambda r: -r["created_at"])
        items = [r for r in items if not kind or r["kind"] == kind][:limit]
    else:
        items = list(col.find(q, {"result": 0}).sort("created_at", -1).limit(limit))
    return {"runs": [{k: r.get(k) for k in ("_id", "kind", "thread_id", "status", "created_at", "finished_at", "metrics", "provider", "prompt_version", "error")} for r in items]}
