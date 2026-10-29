"""Run manager: async agent runs with persisted state, streamed progress events,
idempotency, budgets and a signed callback to the API when a run settles.

A run is one invocation of the drafting graph for a JD thread (start, resume
after an interrupt, or a refinement). Short synchronous agents (review, revise,
Q&A, ops) are also recorded as runs so every AI action is traced and counted.
"""
from __future__ import annotations

import json
import threading
import time
import traceback
import uuid
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Callable, Optional

import httpx

from . import runctx, services
from .config import settings
from .guard import redact

_executor = ThreadPoolExecutor(max_workers=4)
_thread_locks: dict[str, threading.Lock] = defaultdict(threading.Lock)
_mem_runs: dict[str, dict] = {}
_idem: dict[str, str] = {}


def _col():
    db = services.get_db()
    return db["agent_runs"] if db is not None else None


def save(run: dict) -> None:
    col = _col()
    if col is not None:
        col.replace_one({"_id": run["_id"]}, run, upsert=True)
    else:
        _mem_runs[run["_id"]] = json.loads(json.dumps(run, default=str))


def get(run_id: str) -> Optional[dict]:
    col = _col()
    if col is not None:
        return col.find_one({"_id": run_id})
    return _mem_runs.get(run_id)


def find_by_idempotency(key: str) -> Optional[dict]:
    if not key:
        return None
    col = _col()
    if col is not None:
        return col.find_one({"idempotency_key": key})
    rid = _idem.get(key)
    return _mem_runs.get(rid) if rid else None


def tokens_today(user_hash: str) -> int:
    col = _col()
    since = time.time() - 86400
    if col is None:
        runs = [r for r in _mem_runs.values() if r.get("user_hash") == user_hash and r.get("created_at", 0) >= since]
    else:
        runs = list(col.find({"user_hash": user_hash, "created_at": {"$gte": since}}, {"metrics": 1}))
    return sum(int((r.get("metrics") or {}).get("input_tokens", 0)) + int((r.get("metrics") or {}).get("output_tokens", 0)) for r in runs)


def new_run(kind: str, thread_id: str = "", user_hash: str = "", idempotency_key: str = "", input_preview: str = "") -> dict:
    run = {
        "_id": uuid.uuid4().hex,
        "kind": kind,
        "thread_id": thread_id,
        "user_hash": user_hash,
        "idempotency_key": idempotency_key or None,
        "status": "queued",
        "created_at": time.time(),
        "finished_at": None,
        "events": [],
        "result": None,
        "metrics": {},
        "llm_calls": [],
        "tool_calls": [],
        "provider": settings.llm_backend,
        "models": {"large": settings.model_large, "small": settings.model_small} if settings.use_llm else {},
        "prompt_version": settings.prompt_version,
        "input_preview": redact(input_preview)[:300],
        "error": None,
        "callback": {"status": "pending", "attempts": 0},
    }
    if idempotency_key:
        _idem[idempotency_key] = run["_id"]
    save(run)
    return run


def _ctx_for(run: dict) -> runctx.RunContext:
    ctx = runctx.RunContext(run_id=run["_id"], kind=run["kind"], user_hash=run.get("user_hash", ""), jd_id=run.get("thread_id", ""),
                            max_tokens=settings.max_tokens_per_run, max_tool_calls=settings.max_tool_calls)
    if run.get("user_hash") and settings.use_llm and tokens_today(run["user_hash"]) > settings.daily_token_budget_per_user:
        ctx.llm_disabled = True
        ctx.event("budget", "Daily token budget reached; using deterministic agents for this run")
    return ctx


def _finish(run: dict, ctx: runctx.RunContext, status: str, result: Any = None, error: str | None = None) -> dict:
    run["status"] = status
    run["result"] = result
    run["error"] = error
    run["finished_at"] = time.time()
    run["events"] = ctx.events
    run["metrics"] = ctx.summary()
    run["llm_calls"] = ctx.llm_calls
    run["tool_calls"] = ctx.tool_calls
    save(run)
    return run


def _jsonable(x: Any) -> Any:
    if hasattr(x, "model_dump"):
        return x.model_dump()
    if isinstance(x, tuple):  # nested arrays aren't portable across Mongo-compatible stores
        return {f"item{i}": _jsonable(v) for i, v in enumerate(x)}
    if isinstance(x, list):
        return [_jsonable(i) for i in x]
    if isinstance(x, dict):
        return {k: _jsonable(v) for k, v in x.items()}
    return x


def run_sync(kind: str, fn: Callable[[], Any], *, thread_id: str = "", user_hash: str = "", input_preview: str = "") -> tuple[Any, dict]:
    """Execute a short agent synchronously while tracing it as a run."""
    run = new_run(kind, thread_id=thread_id, user_hash=user_hash, input_preview=input_preview)
    ctx = _ctx_for(run)
    tok = runctx.set_current(ctx)
    try:
        run["status"] = "running"
        result = fn()
        payload = _jsonable(result)
        _finish(run, ctx, "completed", payload)
        return result, run
    except Exception as e:
        _finish(run, ctx, "failed", None, f"{type(e).__name__}: {e}")
        raise
    finally:
        runctx.reset(tok)


# --------------------------------------------------------------------------- drafting runs

def _graph_state_summary(graph, cfg) -> dict:
    st = graph.get_state(cfg)
    values = st.values or {}
    interrupts = []
    for t in st.tasks or []:
        for i in getattr(t, "interrupts", ()) or ():
            interrupts.append(i.value)
    return {"values": values, "interrupts": interrupts, "next": list(st.next or [])}


def start_draft_run(thread_id: str, message: str, context: dict, user_hash: str, idempotency_key: str = "") -> dict:
    existing = find_by_idempotency(idempotency_key)
    if existing:
        return existing
    run = new_run("draft", thread_id=thread_id, user_hash=user_hash, idempotency_key=idempotency_key, input_preview=message)
    _executor.submit(_execute_draft, run, message, context)
    return run


def _execute_draft(run: dict, message: str, context: dict) -> None:
    from langgraph.types import Command

    from .graph.draft_graph import get_graph

    ctx = _ctx_for(run)
    tok = runctx.set_current(ctx)
    lock = _thread_locks[run["thread_id"]]
    try:
        with lock:
            run["status"] = "running"
            save(run)
            graph = get_graph()
            cfg = {"configurable": {"thread_id": run["thread_id"]}, "recursion_limit": settings.max_graph_steps}
            before = _graph_state_summary(graph, cfg)
            ctx_update = {"existing": context.get("existing") or {}, "org": context.get("org") or {},
                          "prefs": context.get("prefs") or {}, "jd_id": run["thread_id"]}
            if before["interrupts"]:
                inp: Any = Command(resume=message, update=ctx_update)
                ctx.event("resume", "Resuming paused run with the author's reply")
            else:
                inp = {"messages": [{"role": "user", "content": message}], **ctx_update}
            last_saved = time.time()
            for update in graph.stream(inp, cfg, stream_mode="updates"):
                # persist progress so the UI can show live steps while polling
                if time.time() - last_saved > 0.4:
                    run["events"] = ctx.events
                    run["metrics"] = ctx.summary()
                    save(run)
                    last_saved = time.time()
            after = _graph_state_summary(graph, cfg)
            vals = after["values"]
            if after["interrupts"]:
                intr = after["interrupts"][0]
                if intr.get("type") == "question":
                    result = {"type": "question", "assistant_message": intr.get("question"), "field": intr.get("field"),
                              "brief": vals.get("brief"), "confidence": vals.get("confidence"), "missing": vals.get("missing")}
                else:
                    qs = intr.get("questions") or []
                    msg = ("I've drafted the JD, but need your input before it's ready:\n"
                           + "\n".join(f"{i + 1}. {q['question']}" for i, q in enumerate(qs))
                           + "\n\nReply with answers, or say \"looks good\" to keep the draft as is.")
                    result = {"type": "review", "assistant_message": msg, "questions": qs,
                              "proposal": _proposal_from(vals), "brief": vals.get("brief"), "confidence": vals.get("confidence")}
                _finish(run, ctx, "needs_input", result)
            else:
                final = vals.get("final") or {}
                msgs = vals.get("messages") or []
                last_assistant = next((m["content"] for m in reversed(msgs) if m["role"] == "assistant"), "")
                result = {"type": "draft", "assistant_message": last_assistant, "proposal": final,
                          "brief": vals.get("brief"), "confidence": vals.get("confidence")}
                _finish(run, ctx, "completed", result)
    except Exception as e:
        ctx.event("error", f"{type(e).__name__}: {e}")
        _finish(run, ctx, "failed", {"type": "error", "assistant_message": "Sorry — the drafting agent hit an error. Your message was saved; please try again."},
                f"{type(e).__name__}: {e}\n{traceback.format_exc()[-1500:]}")
    finally:
        runctx.reset(tok)
    _callback(run)


def _proposal_from(vals: dict) -> dict:
    """Partial proposal while waiting on the human gate (so the editor shows the draft)."""
    from .graph.draft_graph import _sources, flat_draft

    draft = vals.get("draft")
    if not draft:
        return {}
    return {"fields": flat_draft(draft), "bullets": {s: draft.get(s, []) for s in ("responsibilities", "qualifications")},
            "field_meta": vals.get("field_meta") or {}, "confidence": vals.get("confidence") or {},
            "critique": vals.get("critique") or {}, "initial_critique": vals.get("initial_critique") or {},
            "fixes_applied": vals.get("fixes_applied") or [], "sources": _sources(draft, vals.get("retrieved") or []),
            "escalated": True, "gen_method": vals.get("gen_method")}


def _callback(run: dict) -> None:
    """POST the settled run to the API (signed). Retries with backoff; the API
    applies it idempotently by run id, and also pulls on poll as a backstop."""
    if not settings.callback_url:
        return
    from .security import sign

    payload = json.dumps({"runId": run["_id"], "jdId": run["thread_id"], "kind": run["kind"], "status": run["status"],
                          "result": run["result"], "metrics": run["metrics"]}, default=str).encode()
    path = httpx.URL(settings.callback_url).path
    for attempt in range(4):
        try:
            ts, sig = sign("POST", path, payload)
            r = httpx.post(settings.callback_url, content=payload, timeout=10,
                           headers={"content-type": "application/json", "x-agent-timestamp": ts, "x-agent-signature": sig})
            run["callback"] = {"status": "ok" if r.status_code < 300 else f"http_{r.status_code}", "attempts": attempt + 1}
            if r.status_code < 500:
                break
        except Exception as e:
            run["callback"] = {"status": f"error: {e}"[:200], "attempts": attempt + 1}
        time.sleep(0.5 * (2 ** attempt))
    save(run)


def reset_thread(thread_id: str) -> None:
    from .graph.draft_graph import get_graph

    graph = get_graph()
    try:
        graph.checkpointer.delete_thread(thread_id)
    except Exception:
        pass


def thread_state(thread_id: str) -> dict:
    from .graph.draft_graph import get_graph

    graph = get_graph()
    s = _graph_state_summary(graph, {"configurable": {"thread_id": thread_id}})
    v = s["values"]
    return {"brief": v.get("brief"), "confidence": v.get("confidence"), "missing": v.get("missing"),
            "interrupts": s["interrupts"], "has_draft": bool(v.get("final") or v.get("draft"))}


# --------------------------------------------------------------------------- metrics

def _pct(vals: list[float], p: float) -> float:
    if not vals:
        return 0.0
    vals = sorted(vals)
    k = min(len(vals) - 1, max(0, int(round(p / 100 * (len(vals) - 1)))))
    return round(vals[k], 1)


def metrics_summary(days: int = 30) -> dict:
    since = time.time() - days * 86400
    col = _col()
    runs = list(col.find({"created_at": {"$gte": since}})) if col is not None else [r for r in _mem_runs.values() if r["created_at"] >= since]
    by_kind: dict[str, list] = defaultdict(list)
    for r in runs:
        by_kind[r["kind"]].append(r)
    drafts = by_kind.get("draft", [])
    settled = [r for r in drafts if r["status"] in ("completed", "needs_input", "failed")]
    lat = [float((r.get("metrics") or {}).get("latency_ms", 0)) for r in runs if r["status"] != "running"]
    tool_calls = [t for r in runs for t in r.get("tool_calls") or []]
    llm_calls = [c for r in runs for c in r.get("llm_calls") or []]
    completed = [r for r in drafts if r["status"] == "completed"]
    reviews = [r for r in drafts if (r.get("result") or {}).get("type") == "review"]
    gen_valid = [(r.get("metrics") or {}).get("first_pass_valid") for r in drafts if (r.get("metrics") or {}).get("first_pass_valid") is not None]
    fail_reasons: dict[str, int] = defaultdict(int)
    for r in runs:
        if r["status"] == "failed":
            fail_reasons[(r.get("error") or "unknown").split(":")[0]] += 1
    score_gain = []
    for r in completed:
        prop = (r.get("result") or {}).get("proposal") or {}
        a, b = (prop.get("initial_critique") or {}).get("rubric"), (prop.get("critique") or {}).get("rubric")
        if a and b:
            score_gain.append(sum(b.values()) / len(b) - sum(a.values()) / len(a))
    return {
        "window_days": days,
        "runs_total": len(runs),
        "runs_by_kind": {k: len(v) for k, v in by_kind.items()},
        "draft_success_rate": round(sum(1 for r in settled if r["status"] != "failed") / len(settled), 3) if settled else None,
        "escalation_rate": round(len(reviews) / len(settled), 3) if settled else None,
        "latency_ms": {"p50": _pct(lat, 50), "p95": _pct(lat, 95), "p99": _pct(lat, 99)},
        "cost_usd_total": round(sum(float((r.get("metrics") or {}).get("cost_usd", 0)) for r in runs), 4),
        "cost_usd_per_run_p95": _pct([float((r.get("metrics") or {}).get("cost_usd", 0)) for r in runs], 95),
        "tokens": {"input": sum(int((r.get("metrics") or {}).get("input_tokens", 0)) for r in runs),
                   "output": sum(int((r.get("metrics") or {}).get("output_tokens", 0)) for r in runs),
                   "cache_read": sum(int((r.get("metrics") or {}).get("cache_read_tokens", 0)) for r in runs)},
        "tool_calls": len(tool_calls),
        "tool_error_rate": round(sum(1 for t in tool_calls if not t["ok"]) / len(tool_calls), 3) if tool_calls else None,
        "avg_tool_calls_per_draft": round(sum(len(r.get("tool_calls") or []) for r in drafts) / len(drafts), 2) if drafts else None,
        "llm_calls": len(llm_calls),
        "llm_error_rate": round(sum(1 for c in llm_calls if not c["ok"]) / len(llm_calls), 3) if llm_calls else None,
        "fallback_rate": round(sum(1 for r in runs if (r.get("metrics") or {}).get("fallbacks", 0) > 0) / len(runs), 3) if runs else None,
        "first_pass_schema_validity": round(sum(1 for v in gen_valid if v) / len(gen_valid), 3) if gen_valid else None,
        "critic_score_gain_avg": round(sum(score_gain) / len(score_gain), 3) if score_gain else None,
        "provider": settings.llm_backend,
        "top_failure_reasons": sorted(fail_reasons.items(), key=lambda kv: -kv[1])[:5],
    }
