"""Layer 9 — operations agent.

Natural-language pipeline questions are routed to a *fixed, validated* catalog
of parameterised analytics queries that the Express API owns and executes.
The model only chooses a query id and parameters; it never writes queries.
The same module drafts reminder messages for JDs stuck in a stage.
"""
from __future__ import annotations

import json
import re
from typing import Any

from pydantic import BaseModel

from .. import llm, runctx
from ..schemas import OpsRoute


def heuristic_route(question: str, catalog: list[dict]) -> OpsRoute:
    q = question.lower()
    ids = {c["id"] for c in catalog}
    days = None
    m = re.search(r"last\s+(\d+)\s+(day|week|month)s?", q)
    if m:
        days = int(m.group(1)) * {"day": 1, "week": 7, "month": 30}[m.group(2)]
    elif "this quarter" in q or "quarter" in q:
        days = 90
    elif "this month" in q or "month" in q:
        days = 30
    elif "this week" in q or "week" in q and "per week" not in q:
        days = 7
    group = "department" if re.search(r"by (department|team|dept)|per (department|team)|each (department|team)", q) else "none"

    def pick(qid: str, params: dict, why: str) -> OpsRoute:
        if qid not in ids:
            qid = next(iter(ids))
        return OpsRoute(query_id=qid, params={k: v for k, v in params.items() if v is not None}, rationale=why)

    if re.search(r"stuck|waiting|overdue|pending (for|longer|more)|blocked|delay", q):
        stage = "pending_hr" if re.search(r"\bhr\b", q) else "pending_manager" if "manager" in q else "any"
        hrs = re.search(r"(\d+)\s*(hours?|hrs?|days?)", q)
        min_age = None
        if hrs:
            min_age = int(hrs.group(1)) * (24 if hrs.group(2).startswith("d") else 1)
        return pick("stuck_jds", {"stage": stage, "min_age_hours": min_age or 48}, "question mentions stuck/waiting items")
    if re.search(r"reject", q):
        return pick("rejection_rate", {"group_by": group if group != "none" else "department", "since_days": days or 90}, "question is about rejections")
    if re.search(r"(approval|approve|cycle|turnaround|time to approv|how long)", q):
        if re.search(r"reviewer|manager review|hr review|who (is|are) slow", q):
            return pick("reviewer_latency", {"since_days": days or 90}, "question is about reviewer speed")
        return pick("avg_approval_time", {"group_by": group, "since_days": days or 90}, "question is about approval time")
    if re.search(r"throughput|per week|weekly|trend|how many .*(approved|created|submitted)", q):
        return pick("throughput", {"weeks": max(1, (days or 56) // 7)}, "question is about volume over time")
    if re.search(r"ai|agent|draft quality|first[- ]draft|edits|edit distance", q):
        return pick("ai_impact", {"since_days": days or 90}, "question is about AI drafting impact")
    return pick("status_counts", {"group_by": group, "since_days": days}, "default: pipeline status breakdown")


ROUTE_SYSTEM = """Route an HR operations question to exactly one analytics query from the catalog.
Choose the query id and fill parameters that satisfy the catalog's parameter schema. Never invent query ids."""


def route(question: str, catalog: list[dict]) -> OpsRoute:
    ctx = runctx.current()
    try:
        res = llm.structured("ops_route", OpsRoute, ROUTE_SYSTEM, f"Catalog: {json.dumps(catalog)}\nQuestion: {question}", tier="small", max_tokens=400)
        if res.query_id in {c["id"] for c in catalog}:
            ctx.event("ops", f"LLM routed to {res.query_id}")
            return res
    except llm.LLMUnavailable:
        pass
    r = heuristic_route(question, catalog)
    ctx.event("ops", f"Rule-routed to {r.query_id}")
    return r


class ReminderDraft(BaseModel):
    to_user_id: str
    to_name: str
    jd_id: str
    subject: str
    message: str


class ReminderDrafts(BaseModel):
    drafts: list[ReminderDraft]


def draft_reminders(items: list[dict]) -> list[dict]:
    """items: {jd_id, jd_title, stage, age_hours, approver_id, approver_name, author_name}"""
    out = []
    for it in items:
        days = round(it["age_hours"] / 24, 1)
        who = "your manager review" if it["stage"] == "pending_manager" else "HR sign-off"
        msg = (f"Hi {it['approver_name'].split()[0]}, \"{it['jd_title']}\" from {it['author_name']} has been waiting for {who} "
               f"for {days} days. Could you take a look today? If something's blocking it, reply here and I'll help unblock.")
        out.append({"to_user_id": it["approver_id"], "to_name": it["approver_name"], "jd_id": it["jd_id"],
                    "subject": f"Reminder: {it['jd_title']} awaiting review", "message": msg})
    runctx.current().event("ops", f"Drafted {len(out)} reminders")
    return out
