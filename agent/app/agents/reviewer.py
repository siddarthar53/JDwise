"""Layer 6 — reviewer copilot (manager and HR stages).

Summarises the JD, shows what changed since the previously submitted version,
flags risks (pay outside band, duplicate role, missing sections, biased
language) and drafts suggested comments. It never approves anything: the
reviewer still clicks approve/reject in the UI.
"""
from __future__ import annotations

import json
from typing import Any, Optional

from .. import knowledge, llm, runctx
from ..guard import as_data
from ..schemas import Finding, ReviewReport, ToolCall
from ..tools import execute_many
from . import critic

SCALARS = ["title", "department", "level", "employmentType", "location", "workMode", "salaryRange", "summary"]
LISTS = ["responsibilities", "qualifications", "skills"]


def diff_versions(prev: Optional[dict], cur: dict) -> list[dict]:
    if not prev:
        return []
    out = []
    for f in SCALARS:
        a, b = (prev.get(f) or ""), (cur.get(f) or "")
        if a != b:
            out.append({"field": f, "type": "changed", "before": a, "after": b})
    for f in LISTS:
        a, b = list(prev.get(f) or []), list(cur.get(f) or [])
        for x in b:
            if x not in a:
                out.append({"field": f, "type": "added", "after": x})
        for x in a:
            if x not in b:
                out.append({"field": f, "type": "removed", "before": x})
    return out


def _describe_change(c: dict) -> str:
    if c["type"] == "changed":
        if c["field"] == "summary":
            return "Summary rewritten"
        return f"{c['field']}: '{c['before'] or '—'}' → '{c['after'] or '—'}'"
    if c["type"] == "added":
        return f"Added to {c['field']}: {c['after']}"
    return f"Removed from {c['field']}: {c['before']}"


def _comment_for(f: Finding) -> str:
    templates = {
        "R-PAY-MISSING": "Please add the base salary range — this location requires it in postings.",
        "R-PAY-BAND": f"The salary ({f.evidence}) is outside the approved band ({f.message.split('band (')[-1].rstrip(').') if 'band (' in f.message else 'see comp'}). Can you confirm with comp or align it?",
        "R-DUP-ROLE": f"{f.message} Is this a new headcount?",
        "R-LEVEL-YEARS": f"{f.message} Could you align the experience requirement with the level?",
        "R-INCLUSIVE": f"Please rephrase: {f.message}",
        "R-STACK-SKILLS": "The skills list is long — can we keep only the must-haves?",
        "R-STACK-IMPOSSIBLE": f"{f.message}",
        "R-VAGUE": f"This bullet is vague: \"{f.evidence[:80]}\" — what's the concrete outcome?",
    }
    return templates.get(f.rule_id, f"{f.message} {f.suggested_fix}".strip())


REVIEW_SYSTEM = """You assist a manager or HR reviewer who must approve or send back a job description.
Write a 2-3 sentence neutral summary of the role and the most decision-relevant facts (level, location, pay, scope).
Use the deterministic risks provided; you may add at most 3 more concrete risks. Draft short, polite reviewer comments.
recommendation: approve if there are no material risks, request_changes for errors, needs_discussion otherwise.
You do not make the decision; the human reviewer does."""


def review(jd: dict, previous: Optional[dict], stage: str, last_rejection: Optional[str] = None) -> ReviewReport:
    ctx = runctx.current()
    tools = execute_many([
        ToolCall(tool="get_salary_band", args={"department": jd.get("department", ""), "level": jd.get("level") or "mid",
                                                "location": jd.get("location") or "unknown", "title": jd.get("title", "")}),
        ToolCall(tool="check_duplicate_role", args={"title": jd.get("title") or "role", "summary": jd.get("summary", ""), "exclude_id": str(jd.get("_id") or jd.get("id") or "")}),
    ], {}, node="reviewer")
    findings = critic.rule_findings(jd, tools)
    risks = [f for f in findings if f.severity in ("error", "warning")]
    changes = [_describe_change(c) for c in diff_versions(previous, jd)]
    comments = [_comment_for(f) for f in risks[:5]]
    if last_rejection and previous:
        comments.insert(0, f"Previous feedback was: \"{last_rejection[:140]}\" — {'changes were made, please verify they address it' if changes else 'no content changes since then'}.")

    lvl = knowledge.LEVEL_LABEL.get(jd.get("level") or "", "")
    resp = jd.get("responsibilities") or []
    summary = (f"{lvl + ' ' if lvl and lvl.lower() not in (jd.get('title') or '').lower() else ''}{jd.get('title') or 'Untitled role'} in "
               f"{jd.get('department') or 'an unspecified department'} — {jd.get('employmentType') or 'Full-time'}"
               f"{', ' + jd['location'] if jd.get('location') else ''}{' (' + jd['workMode'] + ')' if jd.get('workMode') else ''}. "
               f"Scope: {'; '.join(r[:70] for r in resp[:2]) or 'not described'}. "
               f"Pay: {jd.get('salaryRange') or 'not specified'}.")
    rec = "request_changes" if any(f.severity == "error" for f in risks) else ("needs_discussion" if risks else "approve")
    report = ReviewReport(summary=summary, changes=changes, risks=risks, suggested_comments=comments, recommendation=rec)

    try:
        user = (f"Stage: {stage}\nDeterministic risks: {json.dumps([r.model_dump() for r in risks])[:3000]}\n"
                f"Changes since last submission: {json.dumps(changes)[:1500]}\n" + as_data("jd", json.dumps(jd, default=str)[:6000]))
        res = llm.structured("review", ReviewReport, REVIEW_SYSTEM, user, tier="small", max_tokens=1200)
        extra = [r for r in res.risks if r.message not in {x.message for x in risks}][:3]
        for r in extra:
            r.source = "llm"
        report = ReviewReport(summary=res.summary or summary, changes=changes, risks=risks + extra,
                              suggested_comments=(res.suggested_comments or comments)[:6],
                              recommendation="request_changes" if any(f.severity == "error" for f in risks) else res.recommendation)
    except llm.LLMUnavailable:
        pass
    ctx.event("review", f"Copilot report: {len(report.risks)} risks, recommendation={report.recommendation}")
    return report
