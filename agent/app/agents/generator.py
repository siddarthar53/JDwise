"""Layer 2+3 — retrieval-grounded generation.

``retrieve_context`` pulls section-level evidence from approved JDs, the role
library and the style guide. ``generate`` produces a schema-valid ``GeneratedJD``
where every bullet records its origin (brief / retrieved / tool / memory /
generated) and the chunk ids that support it, so the UI can show citations and
the eval harness can measure groundedness.
"""
from __future__ import annotations

import json
import re
from typing import Any, Optional

from pydantic import ValidationError

from .. import knowledge, llm, runctx, services
from ..guard import as_data
from ..rag.embed import tokenize
from ..rag.retriever import Filters
from ..schemas import Brief, Bullet, GeneratedJD


SPECIALISATIONS = ["frontend", "backend", "machine learning", "devops", "mobile", "ios", "android", "data analyst",
                   "growth", "recruiter", "intern", "manager", "financial", "account executive"]


def _jaccard(a: str, b: str) -> float:
    sa, sb = set(tokenize(a)), set(tokenize(b))
    return len(sa & sb) / (len(sa | sb) or 1)


def retrieve_context(brief: Brief, k: Optional[int] = None) -> list[dict]:
    ret = services.get_retriever()
    base = f"{brief.level} {brief.title} {brief.department}"
    meta = {"level": brief.level, "department": brief.department}
    filt = Filters(doc_types=["jd", "library"], statuses=["approved"])
    hits: dict[str, dict] = {}
    queries = [
        (base + " " + " ".join(brief.responsibilities[:4]), "responsibilities"),
        (base + " " + " ".join(brief.skills[:6]) + " qualifications experience", "qualifications"),
        (base + " summary", "summary"),
        (base + " skills " + " ".join(brief.skills), "skills"),
    ]
    for q, section in queries:
        for h in ret.search(q, k=k or 8, filters=Filters(doc_types=filt.doc_types, statuses=filt.statuses, sections=[section]),
                            query_meta={**meta, "section": section}):
            c = h["chunk"]
            if c["id"] not in hits or hits[c["id"]]["score"] < h["score"]:
                hits[c["id"]] = {"id": c["id"], "doc_id": c["doc_id"], "doc_type": c["doc_type"], "title": c["title"],
                                 "section": c["section"], "text": c["text"], "score": round(h["score"], 4),
                                 "level": (c.get("meta") or {}).get("level", ""), "department": (c.get("meta") or {}).get("department", "")}
    style = ret.search("requirements years experience level inclusive language structure", k=3,
                       filters=Filters(doc_types=["style"]))
    for h in style:
        c = h["chunk"]
        hits[c["id"]] = {"id": c["id"], "doc_id": c["doc_id"], "doc_type": "style", "title": c["title"], "section": "style",
                         "text": c["text"], "score": round(h["score"], 4), "level": "", "department": ""}
    return sorted(hits.values(), key=lambda h: -h["score"])


# --------------------------------------------------------------------------- heuristic generator

def _domain_phrase(brief: Brief) -> str:
    t = brief.title.lower()
    for key, phrase in [("machine learning", "machine learning"), ("ml ", "machine learning"), ("data scien", "data science"),
                        ("data engineer", "data engineering"), ("analyst", "analytics"), ("design", "product design"),
                        ("devops", "DevOps or infrastructure"), ("sre", "site reliability engineering"), ("frontend", "frontend engineering"),
                        ("backend", "backend engineering"), ("engineer", "software engineering"), ("developer", "software development"),
                        ("product manager", "product management"), ("marketing", "marketing"), ("recruit", "recruiting"),
                        ("sales", "B2B sales"), ("account executive", "B2B sales"), ("finance", "finance"), ("accountant", "accounting"),
                        ("success", "customer success")]:
        if key in t + " ":
            return phrase
    return (brief.department or "a related field").lower() if brief.department else "a related field"


def _years_line(brief: Brief) -> tuple[str, str]:
    dom = _domain_phrase(brief)
    if brief.level == "intern":
        return "Currently pursuing a degree in a relevant field, or equivalent practical experience", "generated"
    if brief.yearsExperience:
        return f"{brief.yearsExperience} years of professional experience in {dom}", "brief"
    lo, hi = knowledge.years_for_level(brief.level)
    if brief.level == "junior":
        return f"0-2 years of experience in {dom}, or equivalent projects", "generated"
    if brief.level == "mid":
        return f"{lo}-{hi} years of professional experience in {dom}", "generated"
    return f"{lo}+ years of professional experience in {dom}", "generated"


def _cap(s: str) -> str:
    return s[:1].upper() + s[1:] if s else s


def _lower_first(s: str) -> str:
    return s[:1].lower() + s[1:] if s and not s[:2].isupper() else s


def heuristic_generate(brief: Brief, retrieved: list[dict], tools: dict, prefs: dict) -> tuple[GeneratedJD, dict]:
    style_ids = [r["id"] for r in retrieved if r["doc_type"] == "style"]
    level_label = knowledge.LEVEL_LABEL.get(brief.level, "")
    title = brief.title.strip() or "Untitled Role"
    if brief.level in ("senior", "staff", "principal", "junior") and level_label.lower() not in title.lower() and not re.search(r"\b(sr|jr|ii|iii)\b", title, re.I):
        title = f"{level_label} {title}"
    field_meta: dict[str, Any] = {}

    # The find_similar_jds tool picks the reference roles; prefer evidence from them.
    similar = ((tools.get("find_similar_jds") or {}).get("data") or {}).get("results") or []
    doc_weight = {d["doc_id"]: w for d, w in zip(similar, (1.0, 0.6, 0.3))}
    family = knowledge.family_for(brief.department, brief.title)

    # pull the full section evidence of the best reference role (doc-level retrieval)
    retrieved = list(retrieved)
    have = {r["id"] for r in retrieved}
    if similar:
        for c in services.get_kb().index().chunks:
            if c["doc_id"] == similar[0]["doc_id"] and c["id"] not in have:
                retrieved.append({"id": c["id"], "doc_id": c["doc_id"], "doc_type": c["doc_type"], "title": c["title"],
                                  "section": c["section"], "text": c["text"], "score": 0.3,
                                  "level": (c.get("meta") or {}).get("level", ""), "department": (c.get("meta") or {}).get("department", "")})

    def rank_pool(section: str) -> list[dict]:
        pool = [r for r in retrieved if r["section"] == section]
        if doc_weight:
            preferred = [r for r in pool if r["doc_id"] in doc_weight]
            if len(preferred) >= 3:
                pool = preferred
        # drop evidence from a different specialisation (e.g. "Frontend" bullets for a backend role)
        own = brief.title.lower()
        pool = [r for r in pool if not any(sp in r["title"].lower() and sp not in own for sp in SPECIALISATIONS)] or pool
        def key(r):
            lvl = 1.0 if r["level"] == brief.level else 0.5 if r["level"] else 0.0
            fam = 1.0 if r["department"] and knowledge.family_for(r["department"], r["title"]) == family else 0.0
            return -(r["score"] + 0.8 * doc_weight.get(r["doc_id"], 0.0) + 0.2 * lvl + 0.2 * fam)
        return sorted(pool, key=key)

    # responsibilities
    resp: list[Bullet] = [Bullet(text=_cap(r), origin="brief") for r in brief.responsibilities[:7]]
    # expand terse brief bullets ("Mentor juniors") with a richer, cited bullet that has the same intent
    pool_r = rank_pool("responsibilities")
    used: set[str] = set()
    for i, b in enumerate(resp):
        if b.origin != "brief" or len(b.text.split()) > 3:
            continue
        verb, stems = b.text.split()[0].lower(), {w[:5] for w in tokenize(b.text)[1:] if len(w) > 2}
        for r in pool_r:
            rt = tokenize(r["text"])
            rstems = {w[:5] for w in rt[1:]}
            same_intent = rt and ((rt[0] == verb and stems & rstems) or (stems and stems <= rstems))
            if r["id"] not in used and same_intent:
                resp[i] = Bullet(text=r["text"], origin="retrieved", citations=[r["id"]])
                used.add(r["id"])
                break
    for r in pool_r:
        if r["id"] in used:
            continue
        if len(resp) >= 6:
            break
        if any(_jaccard(r["text"], b.text) > 0.35 for b in resp):
            continue
        resp.append(Bullet(text=r["text"], origin="retrieved", citations=[r["id"]]))
    if len(resp) < 3:
        generic = [f"Collaborate with cross-functional partners to deliver {brief.department or 'team'} goals",
                   "Document your work so teammates can build on it",
                   "Continuously improve processes, quality and tooling"]
        for g in generic:
            if len(resp) >= 4:
                break
            resp.append(Bullet(text=g, origin="generated"))

    # qualifications
    yl, yorigin = _years_line(brief)
    quals: list[Bullet] = [Bullet(text=yl, origin=yorigin, citations=style_ids[:1] if yorigin == "generated" else [])]
    for q in brief.qualifications:
        if re.search(r"\d+\+?\s*(-\s*\d+\s*)?years", q, re.I):
            continue  # years already covered consistently with level
        quals.append(Bullet(text=_cap(q), origin="brief"))
    skills_tool = (tools.get("normalize_skills") or {}).get("data", {}).get("skills")
    skills = list(skills_tool or brief.skills)
    if skills:
        quals.append(Bullet(text="Hands-on experience with " + ", ".join(skills[:3]) + (" and " + skills[3] if len(skills) > 3 else ""), origin="brief"))
    for r in rank_pool("qualifications"):
        if len(quals) >= 5:
            break
        if re.search(r"\d+\+?\s*(-\s*\d+\s*)?years|degree|pursuing", r["text"], re.I):
            continue
        if any(_jaccard(r["text"], b.text) > 0.35 for b in quals):
            continue
        quals.append(Bullet(text=r["text"], origin="retrieved", citations=[r["id"]]))
    if len(quals) < 2:
        quals.append(Bullet(text="Clear written and verbal communication", origin="generated"))

    # skills: brief first, then learned department preferences, then retrieved
    for s in prefs.get("learnedSkills") or []:
        if s not in skills and len(skills) < 8:
            skills.append(s)
            field_meta.setdefault("skills_from_memory", []).append(s)
    if len(skills) < 4:
        for r in rank_pool("skills"):
            for s in r["text"].split(":", 1)[-1].split(","):
                s = s.strip()
                if s and s not in skills and len(skills) < 6:
                    skills.append(s)
    if not skills:
        skills = ["Communication"]

    # salary
    salary, sal_conf, sal_src = brief.salaryRange, 0.9 if brief.salaryRange else 0.0, "brief"
    band = ((tools.get("get_salary_band") or {}).get("data") or {}).get("band")
    if not salary and band:
        salary, sal_conf, sal_src = band["display"], 0.5, "tool"
    field_meta["salaryRange"] = {"confidence": sal_conf, "source": sal_src}

    # summary
    resp_texts = [b.text for b in resp[:3]]
    work_bits = []
    emp = brief.employmentType or "Full-time"
    if brief.workMode == "remote" or (brief.location or "").lower() == "remote":
        work_bits.append(f"This is a {emp.lower()}, remote role.")
    elif brief.location:
        work_bits.append(f"This is a {emp.lower()}{', ' + brief.workMode if brief.workMode else ''} role based in {brief.location}.")
    tone = (prefs.get("tone") or "friendly").lower()
    lead = f"As {'an' if (level_label or title)[:1].lower() in 'aeiou' else 'a'} {title}{' on the ' + brief.department + ' team' if brief.department else ''}"
    if brief.summaryHint:
        summary = brief.summaryHint.strip()
    elif resp_texts:
        verbs = ", ".join(_lower_first(t) for t in resp_texts[:-1]) + (" and " if len(resp_texts) > 1 else "") + _lower_first(resp_texts[-1])
        if tone == "formal":
            summary = f"{lead}, you will be responsible for the following: {verbs}."
        elif tone == "concise":
            summary = f"{lead}, you'll {verbs}."
        else:
            summary = f"{lead}, you'll {verbs}. You'll work closely with your teammates and partners across the company to make a measurable impact."
    else:
        summary = f"{lead}, you'll help the team deliver on its goals."
    if work_bits:
        summary += " " + " ".join(work_bits)

    jd = GeneratedJD(
        title=title, department=brief.department, level=brief.level, employmentType=emp,
        location=brief.location, workMode=brief.workMode, salaryRange=salary, summary=summary,
        responsibilities=resp[:8], qualifications=quals[:7], skills=skills[:12],
        benefits=list(prefs.get("benefits") or brief.benefits or []),
    )
    return jd, field_meta


# --------------------------------------------------------------------------- LLM generator

GEN_SYSTEM = """You write job descriptions for an HR platform.
Use the brief as the source of truth and the retrieved context (approved JDs, role library, style guide) as evidence.
Rules:
- Follow the style guide: address the candidate as "you", start responsibility bullets with a verb, 4-7 responsibilities, 3-6 qualifications.
- Do NOT invent hard requirements (degrees, certifications, years, tools) that are not in the brief or the retrieved context.
- Keep years of experience consistent with the level (junior 0-2, mid 2-5, senior 5+, staff 8+, principal 10+) unless the brief states years.
- For every bullet set origin: "brief" if it comes from the user's brief, "retrieved" if adapted from a retrieved chunk (put that chunk's id in citations), "tool" if from a tool result, "generated" otherwise.
- Use inclusive, gender-neutral language.
- If the brief has no salary and a salary band tool result exists, use the band's display string; otherwise leave salaryRange empty."""


def llm_generate(brief: Brief, retrieved: list[dict], tools: dict, prefs: dict, feedback: str = "") -> Optional[GeneratedJD]:
    ctx_lines = [f"[{r['id']}] ({r['doc_type']}/{r['section']}, level={r['level']}) {r['title']}: {r['text']}" for r in retrieved[:24]]
    tool_view = {k: v.get("data") for k, v in tools.items() if v.get("ok")}
    user = (
        f"Brief:\n{brief.model_dump_json(indent=1)}\n\n"
        f"Author preferences (tone, benefits): {json.dumps(prefs)[:1200]}\n\n"
        f"Tool results:\n{json.dumps(tool_view)[:3000]}\n\n"
        + as_data("retrieved_context", "\n".join(ctx_lines), max_chars=12000)
        + (f"\n\nReviewer feedback to address:\n{as_data('feedback', feedback)}" if feedback else "")
        + "\n\nWrite the job description."
    )
    try:
        jd = llm.structured("generate", GeneratedJD, GEN_SYSTEM, user, tier="large", max_tokens=3000)
    except llm.LLMUnavailable:
        return None
    valid = {r["id"] for r in retrieved}
    for b in jd.responsibilities + jd.qualifications:
        b.citations = [c for c in b.citations if c in valid]
        if b.origin == "retrieved" and not b.citations:
            b.origin = "generated"
    return jd


def generate(brief: Brief, retrieved: list[dict], tools: dict, prefs: dict) -> tuple[GeneratedJD, dict, str]:
    ctx = runctx.current()
    jd = llm_generate(brief, retrieved, tools, prefs)
    if jd is not None:
        band = ((tools.get("get_salary_band") or {}).get("data") or {}).get("band")
        meta = {"salaryRange": {"confidence": 0.9 if brief.salaryRange else (0.5 if jd.salaryRange else 0.0),
                                "source": "brief" if brief.salaryRange else ("tool" if band and jd.salaryRange else "none")}}
        ctx.event("generate", "Drafted JD with LLM", model_tier="large")
        return jd, meta, "llm"
    jd, meta = heuristic_generate(brief, retrieved, tools, prefs)
    if ctx.first_pass_valid is None:
        ctx.first_pass_valid = True
    ctx.event("generate", "Drafted JD with deterministic generator")
    return jd, meta, "heuristic"


def coerce_valid(data: dict) -> GeneratedJD:
    """Validate a dict into GeneratedJD, repairing common problems deterministically."""
    try:
        return GeneratedJD.model_validate(data)
    except ValidationError:
        d = dict(data)
        d["summary"] = (d.get("summary") or f"Join the team as {d.get('title', 'a teammate')}.").ljust(20, ".")
        for sec, filler in (("responsibilities", "Collaborate with cross-functional partners"),
                            ("qualifications", "Clear written and verbal communication")):
            items = [b if isinstance(b, dict) else {"text": b} for b in (d.get(sec) or []) if (b.get("text") if isinstance(b, dict) else b)]
            need = 3 if sec == "responsibilities" else 2
            while len(items) < need:
                items.append({"text": filler, "origin": "generated"})
            d[sec] = items[:10]
        d["skills"] = (d.get("skills") or ["Communication"])[:20]
        d["title"] = d.get("title") or "Untitled Role"
        return GeneratedJD.model_validate(d)
