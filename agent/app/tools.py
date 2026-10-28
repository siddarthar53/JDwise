"""Agent tools.

All tools are read-only. There is deliberately no tool that can submit, approve
or reject a JD: the approval state machine lives in the Express API and only
humans drive it. Every call goes through ``execute`` which enforces an
allow-list, argument schemas, a per-run call cap, timeouts, retries with
backoff and an idempotency cache (same tool + args in one run → cached result).
"""
from __future__ import annotations

import json
import time
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FutTimeout
from dataclasses import dataclass
from typing import Any, Callable, Optional

from pydantic import BaseModel, Field, ValidationError

from . import knowledge, runctx, services
from .rag.retriever import Filters
from .schemas import ToolCall

_pool = ThreadPoolExecutor(max_workers=8)          # runs tool bodies (timeouts)
_outer = ThreadPoolExecutor(max_workers=6)         # fans out independent calls


class FindSimilarArgs(BaseModel):
    role: str = Field(min_length=1)
    level: str = ""
    department: str = ""
    k: int = Field(default=3, ge=1, le=8)


class OrgContextArgs(BaseModel):
    user: str = "author"


class SalaryBandArgs(BaseModel):
    department: str = ""
    level: str = Field(min_length=1)
    location: str = Field(min_length=1)
    title: str = ""


class NormalizeSkillsArgs(BaseModel):
    skills: list[str]


class DuplicateArgs(BaseModel):
    title: str = Field(min_length=1)
    summary: str = ""
    exclude_id: str = ""
    threshold: float = 0.82


def _find_similar(a: FindSimilarArgs, state: dict) -> dict:
    q = f"{a.level} {a.role} {a.department}".strip()
    docs = services.get_retriever().similar_docs(
        q, k=a.k, filters=Filters(doc_types=["jd", "library"], statuses=["approved"]),
        query_meta={"level": a.level, "department": a.department},
    )
    return {"results": [{"doc_id": d["doc_id"], "title": d["title"], "type": d["doc_type"], "level": d["meta"].get("level"),
                         "department": d["meta"].get("department"), "score": round(d["score"], 3)} for d in docs]}


def _org_context(a: OrgContextArgs, state: dict) -> dict:
    return dict(state.get("org") or {})


def _salary_band(a: SalaryBandArgs, state: dict) -> dict:
    band = knowledge.salary_band(a.department, a.level, a.location, a.title)
    return {"band": band, "pay_transparency": knowledge.pay_transparency_applies(a.location)}


def _normalize(a: NormalizeSkillsArgs, state: dict) -> dict:
    skills, log = knowledge.normalize_skills(a.skills)
    return {"skills": skills, "mapping": log}


def _duplicate(a: DuplicateArgs, state: dict) -> dict:
    ret = services.get_retriever()
    hits = ret.search(f"{a.title}. {a.summary}", k=5, mode="vector", rerank=False,
                      filters=Filters(doc_types=["jd"], statuses=["approved", "pending_manager", "pending_hr", "draft"],
                                      exclude_doc_ids={a.exclude_id} if a.exclude_id else set(), sections=["summary"]))
    from .rag.embed import get_embedder
    import numpy as np

    out = []
    if hits:
        emb = get_embedder()
        qv = emb.embed([f"{a.title}"])[0]
        for h in hits:
            tv = emb.embed([h["chunk"]["title"]])[0]
            title_sim = float(np.dot(qv, tv))
            sim = 0.5 * title_sim + 0.5 * h["scores"]["dense"]
            if title_sim >= a.threshold or sim >= a.threshold:
                out.append({"doc_id": h["chunk"]["doc_id"], "title": h["chunk"]["title"], "status": h["chunk"]["meta"].get("status"),
                            "similarity": round(sim, 3), "title_similarity": round(title_sim, 3)})
    return {"duplicates": out}


@dataclass
class ToolSpec:
    name: str
    description: str
    args: type[BaseModel]
    fn: Callable[[Any, dict], dict]
    timeout_s: float = 5.0
    retries: int = 1


TOOLS: dict[str, ToolSpec] = {
    "find_similar_jds": ToolSpec("find_similar_jds", "Find previously approved JDs / library roles similar to a role and level.", FindSimilarArgs, _find_similar),
    "get_org_context": ToolSpec("get_org_context", "Get the author's department, manager and team composition.", OrgContextArgs, _org_context),
    "get_salary_band": ToolSpec("get_salary_band", "Look up the approved salary band for department, level and location.", SalaryBandArgs, _salary_band),
    "normalize_skills": ToolSpec("normalize_skills", "Map free-form skill names to the canonical skills taxonomy.", NormalizeSkillsArgs, _normalize),
    "check_duplicate_role": ToolSpec("check_duplicate_role", "Check whether an open or approved JD already covers this role.", DuplicateArgs, _duplicate),
}

# Which tools each graph node may use (allow-list).
ALLOWED = {
    "tools": {"find_similar_jds", "get_org_context", "get_salary_band", "normalize_skills", "check_duplicate_role"},
    "reviewer": {"find_similar_jds", "get_salary_band", "check_duplicate_role"},
    "reviser": {"get_salary_band", "normalize_skills"},
}


def tool_catalog() -> list[dict]:
    return [{"name": t.name, "description": t.description, "args": t.args.model_json_schema()} for t in TOOLS.values()]


def execute(call: ToolCall, state: dict, node: str = "tools", cache: Optional[dict] = None) -> dict:
    ctx = runctx.current()
    spec = TOOLS.get(call.tool)
    t0 = time.time()
    if spec is None or call.tool not in ALLOWED.get(node, set()):
        ctx.record_tool(tool=call.tool, args=call.args, ok=False, latency_ms=0, error="tool not allowed")
        return {"ok": False, "error": f"tool '{call.tool}' not allowed in {node}"}
    if len(ctx.tool_calls) >= ctx.max_tool_calls:
        ctx.record_tool(tool=call.tool, args=call.args, ok=False, latency_ms=0, error="tool-call cap reached")
        return {"ok": False, "error": "tool-call cap reached"}
    try:
        args = spec.args.model_validate(call.args)
    except ValidationError as e:
        ctx.record_tool(tool=call.tool, args=call.args, ok=False, latency_ms=0, error=f"bad args: {e}")
        return {"ok": False, "error": "invalid arguments"}

    key = f"{call.tool}:{json.dumps(args.model_dump(), sort_keys=True)}"
    if cache is not None and key in cache:
        ctx.record_tool(tool=call.tool, args=call.args, ok=True, latency_ms=0, cached=True)
        return cache[key]

    last_err = ""
    for attempt in range(spec.retries + 1):
        try:
            fut = _pool.submit(spec.fn, args, state)
            data = fut.result(timeout=spec.timeout_s)
            res = {"ok": True, "data": data}
            ctx.record_tool(tool=call.tool, args=call.args, ok=True, latency_ms=(time.time() - t0) * 1000)
            if cache is not None:
                cache[key] = res
            return res
        except FutTimeout:
            last_err = "timeout"
        except Exception as e:  # tool bug or backend error
            last_err = str(e)
        time.sleep(0.1 * (2 ** attempt))
    ctx.record_tool(tool=call.tool, args=call.args, ok=False, latency_ms=(time.time() - t0) * 1000, error=last_err)
    return {"ok": False, "error": last_err}


def execute_many(calls: list[ToolCall], state: dict, node: str = "tools", cache: Optional[dict] = None) -> dict[str, dict]:
    """Run independent tool calls in parallel; results keyed by tool name."""
    cache = cache if cache is not None else {}
    results: dict[str, dict] = {}
    ctx = runctx.current()

    def run(c: ToolCall):
        # propagate the run context into worker threads
        t = runctx.set_current(ctx)
        try:
            return c.tool, execute(c, state, node, cache)
        finally:
            runctx.reset(t)

    for name, res in _outer.map(run, calls):
        results[name] = res
    return results
