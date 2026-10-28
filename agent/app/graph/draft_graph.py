"""The drafting workflow as a LangGraph state machine.

    intake ──(missing info)──▶ ask_user ──(interrupt: user answers)──▶ intake
      │ ready
      ▼
    retrieve ─▶ plan_tools ─▶ generate ─▶ validate ─▶ critic ─┬─(fixable & iter<N)─▶ revise ─▶ critic
                                                              ▼
                                                            route ─┬─(needs human)─▶ human_gate ─(interrupt)─▶ apply_answer ─▶ plan_tools
                                                                   └─▶ finalize ─▶ END

State is checkpointed (SQLite) per JD thread, so a run can pause at an
interrupt for hours/days and resume when the author replies.
"""
from __future__ import annotations

import json
import operator
import re
import sqlite3
from pathlib import Path
from typing import Annotated, Any, Optional, TypedDict

from langgraph.checkpoint.sqlite import SqliteSaver
from langgraph.graph import END, START, StateGraph
from langgraph.types import interrupt

from .. import knowledge, llm, runctx
from ..agents import critic as critic_mod
from ..agents import generator, intake
from ..config import settings
from ..rag.embed import tokenize
from ..schemas import Brief, GeneratedJD, ToolCall, ToolPlan
from ..tools import execute_many, tool_catalog

ACCEPT_RE = re.compile(r"^\s*(yes|yep|yeah|ok(ay)?|sure|looks good|lgtm|keep( it)?|accept|that'?s (fine|right|correct)|correct|all good|go ahead|ship it|confirm(ed)?)\b", re.I)


class DraftState(TypedDict, total=False):
    messages: Annotated[list[dict], operator.add]
    existing: dict
    org: dict
    prefs: dict
    jd_id: str
    brief: dict
    confidence: dict
    missing: list
    intake_turns: int
    intake_method: str
    asked: Optional[str]
    asked_history: list
    question: Optional[str]
    ready: bool
    retrieved: list
    tool_results: dict
    draft: dict
    field_meta: dict
    gen_method: str
    critique: dict
    initial_critique: dict
    iterations: int
    fixes_applied: list
    review_questions: list
    human_rounds: int
    human_resolved: bool
    escalated: bool
    final: dict
    last_proposed: dict


# --------------------------------------------------------------------------- helpers

def _step(name: str):
    def deco(fn):
        def wrapper(state: DraftState) -> dict:
            ctx = runctx.current()
            ctx.steps += 1
            return fn(state)
        wrapper.__name__ = fn.__name__
        return wrapper
    return deco


def _jacc(a: str, b: str) -> float:
    sa, sb = set(tokenize(a)), set(tokenize(b))
    return len(sa & sb) / (len(sa | sb) or 1)


def reattach(flat: dict, previous: dict) -> dict:
    """After a flat revision, carry bullet origins/citations over from the
    previous structured draft when the text is (nearly) unchanged."""
    out = dict(previous)
    for k in ("title", "department", "level", "employmentType", "location", "workMode", "salaryRange", "summary", "skills", "benefits"):
        if k in flat:
            out[k] = flat[k]
    for sec in ("responsibilities", "qualifications"):
        prev_bullets = previous.get(sec) or []
        new = []
        for text in flat.get(sec) or []:
            best = max(prev_bullets, key=lambda b: _jacc(b["text"], text), default=None)
            if best and _jacc(best["text"], text) >= 0.5:
                new.append({**best, "text": text})
            else:
                new.append({"text": text, "origin": "generated", "citations": []})
        out[sec] = new
    return out


def flat_draft(d: dict) -> dict:
    return GeneratedJD.model_validate(d).flat()


def _sync_existing(state: DraftState) -> tuple[dict, dict]:
    """If the author hand-edited fields in the UI since our last proposal, treat
    their edits as authoritative brief facts."""
    brief = dict(state.get("brief") or {})
    conf = dict(state.get("confidence") or {})
    existing = state.get("existing") or {}
    last = state.get("last_proposed") or {}
    for f in ("title", "department", "level", "employmentType", "location", "workMode", "salaryRange"):
        ev = (existing.get(f) or "").strip() if isinstance(existing.get(f), str) else ""
        if not ev or ev == "Untitled Job Description":
            continue
        if f == "employmentType" and not last and ev == "Full-time":
            continue  # schema default, not a user statement
        if (last.get(f) and ev != last.get(f)) or (not brief.get(f) and not last):
            brief[f] = ev
            conf[f] = 0.95
    for f in ("responsibilities", "skills", "qualifications"):
        ev = existing.get(f) or []
        if ev and ((last.get(f) and ev != last.get(f)) or (not brief.get(f) and not last)):
            brief[f] = list(ev)
            conf[f] = 0.95
    if existing.get("summary") and last.get("summary") and existing["summary"] != last["summary"]:
        brief["summaryHint"] = existing["summary"]
    return brief, conf


# --------------------------------------------------------------------------- nodes

@_step("intake")
def node_intake(state: DraftState) -> dict:
    brief, conf = _sync_existing(state)
    st = dict(state)
    st["brief"], st["confidence"] = brief, conf
    upd = intake.run_intake(st)
    # a level/location change invalidates a salary that came from the band tool
    sal_src = ((state.get("field_meta") or {}).get("salaryRange") or {}).get("source", "")
    if sal_src.startswith("tool") and state.get("last_proposed"):
        old_b, new_b = brief, upd["brief"]
        if old_b.get("level") != new_b.get("level") or old_b.get("location") != new_b.get("location"):
            upd["brief"]["salaryRange"] = ""
            upd["confidence"] = {**upd["confidence"], "salaryRange": 0.0}
    if state.get("last_proposed") and not upd.get("missing"):
        # refinement of an existing draft: don't re-interview, just regenerate
        upd.update(ready=True, question=None, asked=None)
    if upd.get("question"):
        upd["messages"] = [{"role": "assistant", "content": upd["question"], "kind": "question"}]
    return upd


@_step("ask_user")
def node_ask_user(state: DraftState) -> dict:
    answer = interrupt({"type": "question", "question": state.get("question"), "field": state.get("asked")})
    return {"messages": [{"role": "user", "content": str(answer)}]}


@_step("retrieve")
def node_retrieve(state: DraftState) -> dict:
    brief = Brief(**state["brief"])
    hits = generator.retrieve_context(brief)
    runctx.current().event("retrieve", f"Retrieved {len(hits)} chunks from approved JDs, role library and style guide",
                           top=[h["title"] for h in hits[:3]])
    return {"retrieved": hits}


def heuristic_tool_plan(brief: Brief, jd_id: str) -> list[ToolCall]:
    calls = [ToolCall(tool="find_similar_jds", args={"role": brief.title or brief.department or "role", "level": brief.level, "department": brief.department}),
             ToolCall(tool="get_org_context", args={"user": "author"}),
             ToolCall(tool="check_duplicate_role", args={"title": brief.title or "role", "summary": " ".join(brief.responsibilities[:3]), "exclude_id": jd_id})]
    if brief.skills:
        calls.append(ToolCall(tool="normalize_skills", args={"skills": brief.skills}))
    if brief.level and brief.location:
        calls.append(ToolCall(tool="get_salary_band", args={"department": brief.department, "level": brief.level, "location": brief.location, "title": brief.title}))
    return calls


PLAN_SYSTEM = """You decide which read-only tools to call before drafting a job description.
Call get_salary_band when level and location are known. Call normalize_skills when skills were given.
Always call find_similar_jds and check_duplicate_role. Call get_org_context to learn the team.
Only use tools from the catalog, with arguments that match their schemas."""


@_step("plan_tools")
def node_plan_tools(state: DraftState) -> dict:
    brief = Brief(**state["brief"])
    calls: list[ToolCall] = []
    method = "heuristic"
    if settings.use_llm:
        try:
            plan = llm.structured("plan_tools", ToolPlan, PLAN_SYSTEM,
                                  f"Tool catalog: {json.dumps(tool_catalog())[:4000]}\nBrief: {brief.model_dump_json()}\nJD id to exclude from duplicate search: {state.get('jd_id', '')}",
                                  tier="small", max_tokens=800)
            calls = plan.calls[: settings.max_tool_calls]
            method = "llm"
        except llm.LLMUnavailable:
            calls = []
    if not calls:
        calls = heuristic_tool_plan(brief, state.get("jd_id", ""))
        method = "heuristic"
    results = execute_many(calls, dict(state), node="tools")
    ok = sum(1 for r in results.values() if r.get("ok"))
    runctx.current().event("tools", f"Called {len(calls)} tools ({ok} ok) via {method} plan", tools=[c.tool for c in calls])
    return {"tool_results": results}


@_step("generate")
def node_generate(state: DraftState) -> dict:
    brief = Brief(**state["brief"])
    jd, meta, method = generator.generate(brief, state.get("retrieved") or [], state.get("tool_results") or {}, state.get("prefs") or {})
    return {"draft": jd.model_dump(), "field_meta": meta, "gen_method": method, "iterations": 0, "fixes_applied": []}


@_step("validate")
def node_validate(state: DraftState) -> dict:
    jd = generator.coerce_valid(state["draft"])
    return {"draft": jd.model_dump()}


@_step("critic")
def node_critic(state: DraftState) -> dict:
    if not settings.critic_enabled:
        return {"critique": {"findings": [], "rubric": {}, "passed": True}}
    c = critic_mod.critique(flat_draft(state["draft"]), state.get("brief") or {}, state.get("tool_results") or {})
    upd: dict = {"critique": c.model_dump()}
    if not state.get("iterations"):
        upd["initial_critique"] = c.model_dump()
    return upd


def after_critic(state: DraftState) -> str:
    c = state.get("critique") or {}
    fixable = [f for f in c.get("findings", []) if f.get("auto_fixable") and f.get("severity") in ("error", "warning", "info")]
    if fixable and int(state.get("iterations") or 0) < settings.critic_max_iters:
        return "revise"
    return "route"


@_step("revise")
def node_revise(state: DraftState) -> dict:
    from ..schemas import Finding

    findings = [Finding(**f) for f in (state.get("critique") or {}).get("findings", []) if f.get("auto_fixable")]
    flat = flat_draft(state["draft"])
    new_flat = critic_mod.llm_revise(flat, findings, state.get("brief") or {}) if settings.use_llm else None
    applied = ["LLM revision of flagged issues"] if new_flat else []
    if new_flat is None:
        new_flat, applied = critic_mod.heuristic_fix(flat, findings, state.get("tool_results") or {})
    # deterministic fixes always run after an LLM revision too (rules must hold)
    new_flat, more = critic_mod.heuristic_fix(new_flat, critic_mod.rule_findings(new_flat, state.get("tool_results") or {}), state.get("tool_results") or {})
    applied += [a for a in more if a not in applied]
    merged = reattach(new_flat, state["draft"])
    merged = generator.coerce_valid(merged).model_dump()
    fm = dict(state.get("field_meta") or {})
    if new_flat.get("salaryRange") and not flat.get("salaryRange"):
        fm["salaryRange"] = {"confidence": 0.5, "source": "tool"}
    runctx.current().event("revise", "Applied fixes: " + "; ".join(applied) if applied else "No fixes applied")
    return {"draft": merged, "iterations": int(state.get("iterations") or 0) + 1,
            "fixes_applied": list(state.get("fixes_applied") or []) + applied, "field_meta": fm}


@_step("route")
def node_route(state: DraftState) -> dict:
    """Confidence-based routing: decide whether a human must weigh in."""
    qs: list[dict] = []
    brief, conf = state.get("brief") or {}, state.get("confidence") or {}
    thr = settings.confidence_threshold
    labels = {"level": "seniority level", "department": "department", "title": "job title", "employmentType": "employment type"}
    for f in ("title", "department", "level"):
        if brief.get(f) and conf.get(f, 0) < thr:
            qs.append({"id": f"confirm_{f}", "field": f, "question": f"I assumed the {labels[f]} is **{brief[f]}** — is that right?"})
        elif not brief.get(f):
            qs.append({"id": f"missing_{f}", "field": f, "question": f"I couldn't determine the {labels[f]}. What should it be?"})
    if not brief.get("responsibilities"):
        qs.append({"id": "missing_responsibilities", "field": "responsibilities",
                   "question": "I filled responsibilities from similar approved roles. Anything specific this person must own?"})
    fm = state.get("field_meta") or {}
    sal = (fm.get("salaryRange") or {})
    draft = state.get("draft") or {}
    if sal.get("source") == "tool" and draft.get("salaryRange"):
        qs.append({"id": "confirm_salary", "field": "salaryRange",
                   "question": f"I used the approved band **{draft['salaryRange']}** for salary. Keep it, or give me a different range?"})
    c = state.get("critique") or {}
    for f in c.get("findings", []):
        if f["severity"] == "error" or f["rule_id"] in ("R-DUP-ROLE", "R-PAY-BAND"):
            qs.append({"id": f["rule_id"], "field": f["section"], "question": f"{f['message']} {f.get('suggested_fix', '')}".strip()})
    failed = [k for k, v in (state.get("tool_results") or {}).items() if not v.get("ok")]
    if failed:
        qs.append({"id": "tool_failure", "field": "", "question": f"Some lookups failed ({', '.join(failed)}); please double-check salary and duplicates."})
    rounds = int(state.get("human_rounds") or 0)
    # after one human round, only re-escalate for hard errors
    if rounds >= 1:
        qs = [q for q in qs if q["id"].startswith("R-") and q["id"] not in ("R-DUP-ROLE", "R-PAY-BAND")]
    needs = bool(qs) and rounds < 2 and not state.get("human_resolved")
    runctx.current().event("route", f"{'Escalating to author' if needs else 'Auto-pass'} ({len(qs)} open questions)", escalated=needs)
    return {"review_questions": qs if needs else [], "escalated": needs or bool(state.get("escalated"))}


def after_route(state: DraftState) -> str:
    return "human_gate" if state.get("review_questions") else "finalize"


@_step("human_gate")
def node_human_gate(state: DraftState) -> dict:
    qs = state.get("review_questions") or []
    answer = interrupt({"type": "review", "questions": qs, "draft": flat_draft(state["draft"])})
    return {"messages": [{"role": "user", "content": str(answer)}]}


@_step("apply_answer")
def node_apply_answer(state: DraftState) -> dict:
    answer = next((m["content"] for m in reversed(state.get("messages") or []) if m["role"] == "user"), "")
    brief = Brief(**(state.get("brief") or {}))
    conf = dict(state.get("confidence") or {})
    rounds = int(state.get("human_rounds") or 0) + 1
    if ACCEPT_RE.search(answer) and len(answer.split()) <= 8:
        for q in state.get("review_questions") or []:
            if q.get("field") in conf:
                conf[q["field"]] = max(conf[q["field"]], 0.95)
        fm = dict(state.get("field_meta") or {})
        if "salaryRange" in fm and fm["salaryRange"].get("source") == "tool":
            fm["salaryRange"] = {"confidence": 0.95, "source": "tool_confirmed"}
            brief.salaryRange = (state.get("draft") or {}).get("salaryRange", "")
        runctx.current().event("human", "Author accepted the draft as proposed")
        return {"confidence": conf, "brief": brief.model_dump(), "human_rounds": rounds, "human_resolved": True, "field_meta": fm}
    asked_field = (state.get("review_questions") or [{}])[0].get("field")
    new, new_conf = intake.heuristic_extract(answer, asked_field if len(state.get("review_questions") or []) == 1 else None)
    new_conf = {k: max(v, 0.9) for k, v in new_conf.items()}
    if re.search(r"\b(no|remove|drop|omit)\b.*\bsalary\b|\bsalary\b.*\b(not|no)\b", answer, re.I):
        new.salaryRange, new_conf["salaryRange"] = "", 0.95
    brief, conf = intake.merge(brief, conf, new, new_conf)
    intake.apply_directives(answer, brief, conf)
    for q in state.get("review_questions") or []:
        f = q.get("field")
        if f in ("title", "department", "level") and getattr(brief, f, ""):
            conf[f] = max(conf.get(f, 0), 0.9)
    runctx.current().event("human", "Applied author's answers; regenerating")
    return {"brief": brief.model_dump(), "confidence": conf, "human_rounds": rounds, "human_resolved": rounds >= 2}


def after_answer(state: DraftState) -> str:
    return "finalize" if state.get("human_resolved") and state.get("draft") else "retrieve"


def _sources(draft: dict, retrieved: list[dict]) -> dict:
    """Map every cited chunk id to its text so the UI can show citations."""
    from .. import services

    by_id = {r["id"]: r for r in retrieved}
    out = {}
    for sec in ("responsibilities", "qualifications"):
        for b in draft.get(sec, []):
            for cid in b.get("citations", []):
                r = by_id.get(cid) or services.get_kb().get_chunk(cid)
                if r:
                    out[cid] = {"id": cid, "doc_id": r["doc_id"], "doc_type": r["doc_type"], "title": r["title"],
                                "section": r["section"], "text": r["text"]}
    return out


@_step("finalize")
def node_finalize(state: DraftState) -> dict:
    draft = state["draft"]
    flat = flat_draft(draft)
    c = state.get("critique") or {}
    init = state.get("initial_critique") or c
    fixes = state.get("fixes_applied") or []
    remaining = [f for f in c.get("findings", []) if f["severity"] in ("error", "warning")]
    cited = sum(1 for sec in ("responsibilities", "qualifications") for b in draft.get(sec, []) if b.get("citations"))
    lines = [f"I've drafted **{flat['title']}** using {len({r['doc_id'] for r in state.get('retrieved') or [] if r['doc_type'] != 'style'})} similar approved roles as reference"
             f" ({cited} bullets cite their source)."]
    if fixes:
        lines.append("Before showing it to you, my reviewer pass fixed: " + "; ".join(dict.fromkeys(fixes)) + ".")
    if remaining:
        lines.append("Still worth a look: " + "; ".join(f["message"] for f in remaining[:3]))
    init_score = round(sum(init.get("rubric", {}).values()) / max(1, len(init.get("rubric", {}))), 2) if init.get("rubric") else None
    score = round(sum(c.get("rubric", {}).values()) / max(1, len(c.get("rubric", {}))), 2) if c.get("rubric") else None
    if score is not None:
        lines.append(f"Quality score {init_score} → {score} / 5.")
    lines.append("Review and edit anything on the right, ask me for changes (e.g. 'make it more senior'), then submit for approval.")
    msg = "\n\n".join(lines)
    final = {"fields": flat, "bullets": {sec: draft.get(sec, []) for sec in ("responsibilities", "qualifications")},
             "field_meta": state.get("field_meta") or {}, "confidence": state.get("confidence") or {},
             "critique": c, "initial_critique": init, "fixes_applied": fixes,
             "sources": _sources(draft, state.get("retrieved") or []),
             "escalated": bool(state.get("escalated")), "gen_method": state.get("gen_method")}
    return {"final": final, "last_proposed": flat, "messages": [{"role": "assistant", "content": msg, "kind": "draft"}],
            # reset per-draft control flags so a later refinement starts cleanly
            "human_rounds": 0, "human_resolved": False, "review_questions": [], "ready": False}


# --------------------------------------------------------------------------- build

def build_graph(checkpointer=None):
    g = StateGraph(DraftState)
    for name, fn in [("intake", node_intake), ("ask_user", node_ask_user), ("retrieve", node_retrieve),
                     ("plan_tools", node_plan_tools), ("generate", node_generate), ("validate", node_validate),
                     ("critic", node_critic), ("revise", node_revise), ("route", node_route),
                     ("human_gate", node_human_gate), ("apply_answer", node_apply_answer), ("finalize", node_finalize)]:
        g.add_node(name, fn)
    g.add_edge(START, "intake")
    g.add_conditional_edges("intake", lambda s: "retrieve" if s.get("ready") else "ask_user", ["retrieve", "ask_user"])
    g.add_edge("ask_user", "intake")
    g.add_edge("retrieve", "plan_tools")
    g.add_edge("plan_tools", "generate")
    g.add_edge("generate", "validate")
    g.add_edge("validate", "critic")
    g.add_conditional_edges("critic", after_critic, ["revise", "route"])
    g.add_edge("revise", "critic")
    g.add_conditional_edges("route", after_route, ["human_gate", "finalize"])
    g.add_edge("human_gate", "apply_answer")
    g.add_conditional_edges("apply_answer", after_answer, ["finalize", "retrieve"])
    g.add_edge("finalize", END)
    return g.compile(checkpointer=checkpointer)


_graph = None


def get_graph():
    global _graph
    if _graph is None:
        Path(settings.checkpoint_path).parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(settings.checkpoint_path, check_same_thread=False)
        _graph = build_graph(SqliteSaver(conn))
    return _graph


def set_graph(g) -> None:
    global _graph
    _graph = g
