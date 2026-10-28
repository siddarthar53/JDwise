"""Layer 1 — adaptive intake agent.

Slot-filling loop: state is a partially filled ``Brief``; each turn we extract
whatever the user just said (LLM, or the deterministic extractor as fallback),
merge it, compute per-field confidence and missing slots, and either ask the
single most useful next question or declare the brief ready. Control flow
(required slots, thresholds, turn cap) is deterministic code; the LLM only
extracts and phrases.
"""
from __future__ import annotations

import re
from typing import Optional

from .. import knowledge, llm, runctx
from ..config import settings
from ..guard import as_data, neutralize, strip_injected_sentences
from ..schemas import REQUIRED_BRIEF_FIELDS, Brief, IntakeResult

ROLE_NOUNS = (
    "engineer|developer|designer|manager|analyst|scientist|specialist|lead|architect|recruiter|executive|"
    "marketer|writer|consultant|coordinator|administrator|accountant|intern|director|officer|associate|"
    "representative|strategist|researcher|owner|partner|advocate|technician|editor|copywriter|sre|devops|"
    "programmer|tester|head|controller|planner|generalist|bp"
)
_ROLE_RE = re.compile(rf"\b({ROLE_NOUNS})s?\b", re.IGNORECASE)
_FILLER = re.compile(r"^(an?|the|one|two|three|\d+|new|experienced|strong|great|good|talented|solid)\s+", re.IGNORECASE)

PROCEED_RE = re.compile(
    r"^\s*(go ahead|generate|draft it|draft (it|the jd|now)|that'?s (all|it|enough)|just draft|proceed|skip( the rest)?|"
    r"looks good|done|no(thing)? (more|else)|you decide|use defaults?)\b", re.IGNORECASE)

EXTRA_CITIES = ["remote", "london", "toronto", "singapore", "dubai", "sydney", "tokyo", "berlin"]

QUESTIONS = {
    "title": "What's the job title for this role? (You can also paste an existing JD or a short brief and I'll pull the details out.)",
    "department": "Which department or team will this role sit in?",
    "level": "What seniority is this — intern, junior, mid, senior, staff/principal, lead, or manager?",
    "responsibilities": "What will this person own day to day? A few phrases or bullet points is plenty.",
    "logistics": "Is it full-time, part-time or contract, and where is it based (city, or remote/hybrid)?",
    "salaryRange": "Do you have a salary range in mind? This location has pay-transparency rules — or say 'suggest one' and I'll use the approved band.",
    "skills": "Any must-have skills or tools I should include?",
}


# --------------------------------------------------------------------------- deterministic extraction

def _title_case(s: str) -> str:
    small = {"of", "and", "for", "the", "in", "to"}
    out = []
    for i, w in enumerate(s.split()):
        if w.isupper() and len(w) <= 5:
            out.append(w)
        elif i and w.lower() in small:
            out.append(w.lower())
        else:
            out.append(w[:1].upper() + w[1:])
    return " ".join(out)


def _extract_title(text: str, asked: Optional[str]) -> tuple[str, float]:
    m = re.search(r"(?:job title|title|role|position)\s*[:\-–]\s*([^\n,.;]{3,70})", text, re.IGNORECASE)
    if m:
        return _title_case(m.group(1).strip()), 0.95
    m = re.search(
        r"(?:hiring|hire|looking for|need|needs|recruiting|seeking|want|open(?:ing)? for|backfill(?:ing)?|add)\s+(?:an?\s+|one\s+|two\s+|\d+\s+)?"
        r"([A-Za-z][\w/&+.\- ]{2,70}?\b(?:" + ROLE_NOUNS + r")s?)\b",
        text, re.IGNORECASE)
    if m:
        t = _FILLER.sub("", m.group(1).strip())
        t = re.sub(r"^mid[- ]?level\s+", "", t, flags=re.IGNORECASE)
        t = re.sub(r"^(remote|hybrid|onsite|full[- ]time|part[- ]time|contract)\s+", "", t, flags=re.IGNORECASE)
        if 1 <= len(t.split()) <= 7:
            return _title_case(t), 0.85
    first = text.strip().splitlines()[0].strip() if text.strip() else ""
    if first and len(first.split()) <= 7 and _ROLE_RE.search(first) and not first.endswith("?"):
        return _title_case(re.sub(r"[.:]$", "", _FILLER.sub("", first))), 0.8 if asked == "title" else 0.7
    if asked == "title" and 0 < len(text.split()) <= 7:
        return _title_case(text.strip().rstrip(".")), 0.75
    return "", 0.0


def _extract_department(text: str, title: str, asked: Optional[str]) -> tuple[str, float]:
    m = re.search(r"(?:department|dept|team|org)\s*[:\-–]\s*([A-Za-z][\w &/]{1,40})", text, re.IGNORECASE)
    if m:
        return _norm_dept(m.group(1)), 0.95
    m = re.search(r"\b(?:in|on|for|join(?:ing)?)\s+(?:the|our|my)\s+([A-Za-z][\w &/]{1,30}?)\s+(?:team|department|org|group)\b", text, re.IGNORECASE)
    if m:
        return _norm_dept(m.group(1)), 0.9
    if asked == "department" and 0 < len(text.split()) <= 5:
        return _norm_dept(text.strip().rstrip(".")), 0.85
    inferred = knowledge.infer_department(title)
    if inferred:
        return inferred, 0.6
    return "", 0.0


def _norm_dept(d: str) -> str:
    d = re.sub(r"\b(the|our|team|department|dept)\b", "", d, flags=re.IGNORECASE).strip()
    m = {"eng": "Engineering", "engineering": "Engineering", "hr": "People Ops", "people": "People Ops", "people ops": "People Ops",
         "cs": "Customer Success", "ml": "Data", "ai": "Data", "data science": "Data", "analytics": "Data"}
    return m.get(d.lower(), _title_case(d)) if d else ""


def _extract_level(text: str, title: str, asked: Optional[str]) -> tuple[str, float]:
    m = re.search(r"\blevel\s*[:\-–]\s*([A-Za-z\-]+)", text, re.IGNORECASE)
    if m:
        lv = knowledge.infer_level(m.group(1)) or (m.group(1).lower() if m.group(1).lower() in knowledge.LEVEL_YEARS else None)
        if lv:
            return lv, 0.95
    lv = knowledge.infer_level(title)
    if lv:
        return lv, 0.9
    lv = knowledge.infer_level(text)
    if lv:
        return lv, 0.85 if asked == "level" else 0.75
    yrs = _extract_years(text)
    if yrs:
        lo = int(re.findall(r"\d+", yrs)[0])
        guess = "junior" if lo < 2 else "mid" if lo < 5 else "senior" if lo < 8 else "staff"
        return guess, 0.5
    return "", 0.0


def _extract_years(text: str) -> str:
    m = re.search(r"(\d{1,2})\s*(?:-|to|–)\s*(\d{1,2})\s*\+?\s*(?:years|yrs)", text, re.IGNORECASE)
    if m:
        return f"{m.group(1)}-{m.group(2)}"
    m = re.search(r"(\d{1,2})\s*\+?\s*(?:years|yrs)", text, re.IGNORECASE)
    if m:
        return f"{m.group(1)}+"
    return ""


def _extract_employment(text: str) -> tuple[str, float]:
    t = text.lower()
    for pat, val in [(r"full[- ]?time", "Full-time"), (r"part[- ]?time", "Part-time"), (r"\bcontract(or)?\b|\bfreelance", "Contract"),
                     (r"\binternship\b|\bintern\b", "Internship"), (r"\btemporary\b|\btemp\b", "Temporary")]:
        if re.search(pat, t):
            return val, 0.9
    return "", 0.0


def _extract_workmode(text: str) -> str:
    t = text.lower()
    if re.search(r"\bhybrid\b", t):
        return "hybrid"
    if re.search(r"\b(fully )?remote\b|work from home|wfh", t):
        return "remote"
    if re.search(r"\bon[- ]?site\b|in[- ]office|in the office", t):
        return "onsite"
    return ""


def _all_cities() -> list[str]:
    cities = []
    for meta in knowledge.bands()["regions"].values():
        cities += [c for c in meta["cities"] if len(c) > 3]
    return sorted(set(cities + EXTRA_CITIES) - {"remote"}, key=len, reverse=True)


def _extract_location(text: str) -> tuple[str, float]:
    m = re.search(r"(?:location|based in|based out of|located in|office in)\s*[:\-–]?\s*([A-Z][\w .]{2,40}?)(?=[,.;\n]|$| and | or |\()", text)
    if m:
        return m.group(1).strip(), 0.9
    t = text.lower()
    for c in _all_cities():
        if re.search(r"\b" + re.escape(c) + r"\b", t):
            return _title_case(c), 0.8
    return "", 0.0


_SAL_RE = re.compile(
    r"([$₹£€]\s?\d[\d,.]*\s*[kKmM]?\s*(?:-|to|–)\s*[$₹£€]?\s?\d[\d,.]*\s*[kKmM]?(?:\s*(?:lpa|LPA|per annum|/yr|a year|usd|USD|inr|INR))?"
    r"|\d[\d,.]*\s*(?:-|to|–)\s*\d[\d,.]*\s*(?:lpa|LPA|lakhs?|k|K)\b(?:\s*(?:usd|USD|inr|INR))?"
    r"|[$₹£€]\s?\d[\d,.]*\s*[kKmM]?\b)"
)


def _extract_salary(text: str) -> tuple[str, float]:
    m = _SAL_RE.search(text)
    if m and knowledge.parse_salary(m.group(1)):
        return m.group(1).strip(), 0.9
    return "", 0.0


_RESP_VERB = re.compile(
    r"^(?:they|you|he|she|the person|this person|candidate|the hire)?\s*(?:will|would|should|must|is going to)?\s*(?:be\s+)?(?:responsible for\s+)?"
    r"(own|build|lead|manage|design|develop|drive|create|run|work|support|maintain|ship|define|partner|mentor|write|plan|analy[sz]e|deliver|implement|improve|set|scale|hire|grow|handle|coordinate|operate|research|test|launch|execute|oversee|prepare|review|source|close|onboard|reduce|monitor|contribute|report|align|forecast|recruit|negotiate|sell|interview|coach|optimi[sz]e|automate|investigate|publish|track|grow|establish|evaluate|translate|identify|partner)\w*\b(.*)$",
    re.IGNORECASE)


_VERBS = _RESP_VERB.pattern.split("(own|")[1].split(")")[0]
_VERB_START = re.compile(r"^(own|" + _VERBS + r")\w*\b", re.IGNORECASE)


def _split_compound(item: str) -> list[str]:
    """'Own the API, mentor juniors and improve reliability' -> three bullets."""
    parts = re.split(r",\s*(?:and\s+)?|\s+and\s+", item)
    if len(parts) > 1 and all(_VERB_START.match(p.strip()) for p in parts[1:]):
        return [p.strip()[:1].upper() + p.strip()[1:] for p in parts if p.strip()]
    return [item]


def _extract_responsibilities(text: str, asked: Optional[str]) -> list[str]:
    out: list[str] = []
    sec = re.search(r"(?:responsibilities|what you'?ll do|duties|you will)\s*[:\n](.+?)(?:\n\s*\n|(?:requirements|qualifications|skills|about you|benefits)\s*[:\n]|$)",
                    text, re.IGNORECASE | re.DOTALL)
    src = sec.group(1) if sec else text
    pieces = re.split(r"\n|•|;|(?<=[.!?])\s+(?=[A-Z])", src)
    if asked == "responsibilities" and len(pieces) <= 2 and "," in src:
        pieces = re.split(r",|\band\b", src)
    for p in pieces:
        p = p.strip().strip("-*• ").strip()
        if len(p) < 6:
            continue
        m = _RESP_VERB.match(p)
        if m:
            verb = m.group(1)
            rest = m.group(2).strip().rstrip(".")
            item = (verb[:1].upper() + verb[1:] + (" " + rest if rest else "")).strip()
            if len(item.split()) >= 2:
                out.extend(_split_compound(item))
        elif sec or asked == "responsibilities":
            if len(p.split()) >= 2:
                out.append(p[:1].upper() + p[1:].rstrip("."))
    return out[:10]


def _extract_qualifications(text: str) -> list[str]:
    sec = re.search(r"(?:requirements|qualifications|what you'?ll need|about you|must have)\s*[:\n](.+?)(?:\n\s*\n|(?:benefits|perks|skills|nice to have)\s*[:\n]|$)",
                    text, re.IGNORECASE | re.DOTALL)
    if not sec:
        return []
    items = [p.strip().strip("-*• ").rstrip(".") for p in re.split(r"\n|•|;", sec.group(1))]
    return [i[:1].upper() + i[1:] for i in items if len(i.split()) >= 2][:10]


def heuristic_extract(text: str, asked: Optional[str] = None) -> tuple[Brief, dict[str, float]]:
    text = text or ""
    conf: dict[str, float] = {}
    title, c = _extract_title(text, asked)
    if title:
        conf["title"] = c
    dept, c = _extract_department(text, title, asked)
    if dept:
        conf["department"] = c
    level, c = _extract_level(text, title, asked)
    if level:
        conf["level"] = c
    emp, c = _extract_employment(text)
    if emp:
        conf["employmentType"] = c
    loc, c = _extract_location(text)
    if loc:
        conf["location"] = c
    mode = _extract_workmode(text)
    if mode:
        conf["workMode"] = 0.9
        if not loc and mode == "remote":
            loc, conf["location"] = "Remote", 0.7
    sal, c = _extract_salary(text)
    if sal:
        conf["salaryRange"] = c
    yrs = _extract_years(text)
    if yrs:
        conf["yearsExperience"] = 0.9
    skills = knowledge.find_skills(text)
    if asked == "skills" and not skills:
        skills = [s.strip() for s in re.split(r",|\n|\band\b", text) if 1 <= len(s.strip().split()) <= 4]
    if skills:
        conf["skills"] = 0.85
    resp = _extract_responsibilities(text, asked)
    if resp:
        conf["responsibilities"] = 0.8
    quals = _extract_qualifications(text)
    if quals:
        conf["qualifications"] = 0.85
    if asked == "salaryRange" and re.search(r"suggest|band|you (pick|choose)|not sure|no idea|use the", text, re.IGNORECASE):
        conf["salaryRange"] = 0.0
    brief = Brief(title=title, department=dept, level=level, employmentType=emp, location=loc, workMode=mode,
                  yearsExperience=yrs, salaryRange=sal, skills=skills, responsibilities=resp, qualifications=quals)
    return brief, conf


def apply_directives(text: str, brief: Brief, conf: dict[str, float]) -> None:
    """'make this one but for Senior', 'same but remote' — edits relative to an existing brief."""
    m = re.search(r"\b(?:but|make it|make this|change (?:it|the level) to|for an?|as an?)\s+(?:(?:one\s+)?but\s+)?(?:for\s+)?(?:an?\s+)?(?:more\s+)?(intern|junior|mid(?:-level)?|senior|staff|principal|lead)\b", text, re.IGNORECASE)
    if m and brief.title:
        new = knowledge.infer_level(m.group(1)) or m.group(1).lower().replace("-level", "")
        if new in knowledge.LEVEL_YEARS:
            brief.level = new
            conf["level"] = 0.9
            base = re.sub(r"\b(senior|sr\.?|junior|jr\.?|staff|principal|lead|intern|mid-level)\b\s*", "", brief.title, flags=re.IGNORECASE).strip()
            base = re.sub(r"\s+(i{1,3}|iv)$", "", base, flags=re.IGNORECASE).strip()
            prefix = {"junior": "Junior", "senior": "Senior", "staff": "Staff", "principal": "Principal", "lead": "Lead"}.get(new, "")
            brief.title = f"{prefix} {base}".strip() if prefix else base
            brief.yearsExperience = ""


def merge(prev: Brief, prev_conf: dict[str, float], new: Brief, new_conf: dict[str, float]) -> tuple[Brief, dict[str, float]]:
    data = prev.model_dump()
    conf = dict(prev_conf)
    for f, val in new.model_dump().items():
        if f in ("skills", "responsibilities", "qualifications", "benefits", "notes"):
            if val:
                merged = list(data.get(f) or [])
                for v in val:
                    if v.lower() not in {x.lower() for x in merged}:
                        merged.append(v)
                data[f] = merged
                conf[f] = max(conf.get(f, 0), new_conf.get(f, 0.8))
        elif val:
            nc = new_conf.get(f, 0.7)
            if not data.get(f) or nc >= conf.get(f, 0) - 0.05:
                data[f] = val
                conf[f] = nc
        elif f in new_conf and new_conf[f] == 0.0:
            # explicit "I don't know / suggest one"
            data[f] = ""
            conf[f] = 0.0
    return Brief(**data), conf


# --------------------------------------------------------------------------- control

def missing_fields(brief: Brief, conf: dict[str, float]) -> list[str]:
    miss = []
    for f in REQUIRED_BRIEF_FIELDS:
        v = getattr(brief, f)
        if not v or conf.get(f, 0) < 0.5:
            miss.append(f)
    return miss


def next_question(brief: Brief, conf: dict[str, float], asked_before: list[str]) -> Optional[tuple[str, str]]:
    """Pick the single most valuable next question (field, text), or None if done."""
    order = ["title", "department", "level", "responsibilities"]
    for f in order:
        v = getattr(brief, f)
        if (not v or conf.get(f, 0) < 0.5) and asked_before.count(f) < 2:
            return f, QUESTIONS[f]
    if (not brief.employmentType or not (brief.location or brief.workMode)) and "logistics" not in asked_before:
        return "logistics", QUESTIONS["logistics"]
    if (not brief.salaryRange and settings.pay_transparency_required and knowledge.pay_transparency_applies(brief.location)
            and "salaryRange" not in asked_before):
        return "salaryRange", QUESTIONS["salaryRange"]
    if len(brief.skills) < 2 and "skills" not in asked_before:
        return "skills", QUESTIONS["skills"]
    return None


def _ack(brief: Brief) -> str:
    bits = []
    if brief.level and brief.title and brief.level not in brief.title.lower():
        bits.append(f"{knowledge.LEVEL_LABEL.get(brief.level, brief.level)} {brief.title}")
    elif brief.title:
        bits.append(brief.title)
    if brief.department:
        bits.append(f"in {brief.department}")
    if brief.location:
        bits.append(f"({brief.location}{', ' + brief.workMode if brief.workMode and brief.workMode.lower() not in brief.location.lower() else ''})")
    return ("Got it — " + " ".join(bits) + ". ") if bits else ""


LLM_SYSTEM = """You are the intake step of a job-description drafting assistant.
Extract facts about the role from the conversation into the Brief schema. Rules:
- Only record facts the user actually stated or that follow directly (e.g. department from an unambiguous title). Do not invent.
- level must be one of intern, junior, mid, senior, staff, principal, lead, manager, director (or empty).
- workMode is onsite, hybrid or remote. employmentType is Full-time, Part-time, Contract, Internship or Temporary.
- confidence: 0.9+ when explicitly stated, 0.6-0.8 when inferred, omit when unknown. Use 0.0 for salaryRange if the user asked you to suggest one.
- responsibilities: short imperative phrases. skills: canonical names.
- If the user pasted an existing JD, extract all of its sections. If they ask for a variation ("same but senior"), apply it to the existing brief.
- next_question: one short, friendly question for the most important missing information, or null."""


def llm_extract(history: list[dict], prev: Brief, asked: Optional[str]) -> Optional[tuple[Brief, dict[str, float], Optional[str]]]:
    convo = "\n".join(f"{m['role']}: {strip_injected_sentences(m['content'])[0]}" for m in history[-12:])
    user = (f"Current brief (JSON): {prev.model_dump_json()}\n"
            f"The assistant last asked about: {asked or 'nothing yet'}\n\n"
            + as_data("conversation", convo)
            + "\n\nReturn the full updated brief, confidences and the next question.")
    try:
        res = llm.structured("intake", IntakeResult, LLM_SYSTEM, user, tier="small", max_tokens=1500)
    except llm.LLMUnavailable:
        return None
    return res.brief, res.confidence, res.next_question


def run_intake(state: dict) -> dict:
    """Graph node body. Returns a state update."""
    ctx = runctx.current()
    messages = state.get("messages") or []
    last_user = next((m["content"] for m in reversed(messages) if m["role"] == "user"), "")
    asked = state.get("asked")
    asked_before = list(state.get("asked_history") or [])
    prev = Brief(**(state.get("brief") or {}))
    prev_conf = dict(state.get("confidence") or {})

    proceed = bool(PROCEED_RE.search(last_user or ""))
    clean, dropped = strip_injected_sentences(last_user)
    injected = dropped > 0
    if injected:
        ctx.event("guard", "Instruction-like text in user message was neutralised")

    llm_res = llm_extract(messages, prev, asked)
    if llm_res is not None:
        brief, conf, llm_q = llm_res
        brief, conf = merge(prev, prev_conf, brief, conf)
        method = "llm"
    else:
        new, new_conf = heuristic_extract(clean, asked)
        brief, conf = merge(prev, prev_conf, new, new_conf)
        apply_directives(clean, brief, conf)
        llm_q = None
        method = "heuristic"

    # skills normalisation happens deterministically regardless of extractor
    if brief.skills:
        brief.skills, _ = knowledge.normalize_skills(brief.skills)

    turns = int(state.get("intake_turns") or 0) + 1
    miss = missing_fields(brief, conf)
    q = None if proceed else next_question(brief, conf, asked_before)
    ready = proceed or q is None or turns >= settings.intake_max_turns
    if not ready and q is not None and q[0] not in ("title", "department", "level", "responsibilities") and not miss:
        # only optional slots remain; ask at most one optional question per field
        pass
    ctx.event("intake", f"Extracted brief via {method}; missing: {', '.join(miss) or 'none'}",
              method=method, missing=miss, turns=turns, ready=ready)

    update = {"brief": brief.model_dump(), "confidence": conf, "missing": miss, "intake_turns": turns,
              "ready": ready, "intake_method": method}
    if not ready and q is not None:
        field, text = q
        text = llm_q if (llm_q and field in ("title", "department", "level", "responsibilities")) else text
        update["question"] = _ack(brief) + text
        update["asked"] = field
        update["asked_history"] = asked_before + [field]
    else:
        update["question"] = None
        update["asked"] = None
    return update
