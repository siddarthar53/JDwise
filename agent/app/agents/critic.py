"""Layer 4 — critic / compliance agent and the bounded revise loop.

Deterministic rules cover everything that must never be probabilistic (pay
transparency, banned terms, level/experience contradictions, impossible
"N years of <tech>" requirements, band compliance). When an LLM is available it
adds rubric scores and subtler findings; rule findings are always kept.
"""
from __future__ import annotations

import datetime as _dt
import json
import re
from typing import Any, Optional

from .. import knowledge, llm, runctx
from ..config import settings
from ..guard import as_data
from ..rag.embed import tokenize
from ..schemas import Critique, Finding

CURRENT_YEAR = _dt.date.today().year
_YEARS_RE = re.compile(r"(\d{1,2})\s*(?:\+|-\s*\d{1,2}|to\s*\d{1,2})?\s*\+?\s*(?:years|yrs)(?:\s+of)?(?:\s+(?:professional|hands-on|industry|relevant))?(?:\s+experience)?(?:\s+(?:with|in|using|of))?\s*([A-Za-z0-9.+#/ ]{0,30})", re.IGNORECASE)


def _all_text(jd: dict) -> list[tuple[str, str]]:
    out = [("title", jd.get("title", "")), ("summary", jd.get("summary", ""))]
    for sec in ("responsibilities", "qualifications", "benefits"):
        for i, b in enumerate(jd.get(sec) or []):
            out.append((f"{sec}[{i}]", b))
    return out


def _jacc(a: str, b: str) -> float:
    sa, sb = set(tokenize(a)), set(tokenize(b))
    return len(sa & sb) / (len(sa | sb) or 1)


def rule_findings(jd: dict, tools: Optional[dict] = None) -> list[Finding]:
    tools = tools or {}
    f: list[Finding] = []
    level = (jd.get("level") or "").lower()
    title = jd.get("title") or ""
    resp, quals, skills = jd.get("responsibilities") or [], jd.get("qualifications") or [], jd.get("skills") or []

    # completeness
    if len(title.strip()) < 2:
        f.append(Finding(rule_id="R-COMPLETE-TITLE", severity="error", section="title", message="Job title is missing."))
    if len((jd.get("summary") or "").strip()) < 40:
        f.append(Finding(rule_id="R-COMPLETE-SUMMARY", severity="error", section="summary", message="Summary is missing or too short (aim for 2-4 sentences)."))
    if len(resp) < 3:
        f.append(Finding(rule_id="R-COMPLETE-RESP", severity="error", section="responsibilities", message=f"Only {len(resp)} responsibilities; the style guide asks for 4-7."))
    if len(quals) < 2:
        f.append(Finding(rule_id="R-COMPLETE-QUALS", severity="error", section="qualifications", message="Fewer than 2 qualifications listed."))
    if len(skills) < 3:
        f.append(Finding(rule_id="R-COMPLETE-SKILLS", severity="warning", section="skills", message="List at least 3 key skills."))
    if not level:
        f.append(Finding(rule_id="R-COMPLETE-LEVEL", severity="warning", section="level", message="Seniority level is not set."))

    # level / experience contradictions
    min_years = []
    for i, q in enumerate(quals + resp + [jd.get("summary", "")]):
        for m in _YEARS_RE.finditer(q):
            n = int(m.group(1))
            min_years.append(n)
            tech = (m.group(2) or "").strip()
            canon = knowledge.find_skills(tech)
            for s in canon:
                intro = knowledge.skill_introduced(s)
                if intro and n > CURRENT_YEAR - intro:
                    f.append(Finding(rule_id="R-STACK-IMPOSSIBLE", severity="error", section="qualifications",
                                     message=f"Requires {n} years of {s}, but {s} has only existed since {intro}.",
                                     evidence=q, suggested_fix=f"Ask for at most {CURRENT_YEAR - intro} years, or describe the depth of experience instead.",
                                     auto_fixable=True))
    if min_years and level:
        mx = max(min_years)
        if level in ("intern", "junior") and mx >= 3:
            f.append(Finding(rule_id="R-LEVEL-YEARS", severity="error", section="qualifications",
                             message=f"A {level} role asks for {mx}+ years of experience.", evidence=f"{mx} years",
                             suggested_fix="Use 0-2 years for junior roles (style guide).", auto_fixable=True))
        elif level == "mid" and mx >= 8:
            f.append(Finding(rule_id="R-LEVEL-YEARS", severity="warning", section="qualifications",
                             message=f"A mid-level role asks for {mx}+ years, which reads as senior.", suggested_fix="Use 2-5 years.", auto_fixable=True))
        elif level in ("senior", "staff", "principal", "director") and mx <= 1:
            f.append(Finding(rule_id="R-LEVEL-YEARS", severity="warning", section="qualifications",
                             message=f"A {level} role asks for only {mx} year(s) of experience.", auto_fixable=True))
    txt_all = " ".join(t for _, t in _all_text(jd)).lower()
    if re.search(r"entry[- ]level|new grad|fresh graduates?", txt_all) and min_years and max(min_years) >= 4:
        f.append(Finding(rule_id="R-LEVEL-CONTRADICTION", severity="error", section="summary",
                         message="Described as entry level but requires 4+ years of experience.", auto_fixable=False))
    t_level = knowledge.infer_level(title)
    if t_level and level and t_level != level and {t_level, level} not in ({"lead", "senior"}, {"manager", "lead"}):
        f.append(Finding(rule_id="R-TITLE-LEVEL", severity="warning", section="title",
                         message=f"Title suggests '{t_level}' but level is '{level}'.", evidence=title))

    # inclusive language
    lex = knowledge.lexicon()["terms"]
    for where, text in _all_text(jd):
        for term, meta in lex.items():
            if re.search(r"(?<![A-Za-z])" + re.escape(term) + r"(?![A-Za-z])", text or "", re.IGNORECASE):
                f.append(Finding(rule_id="R-INCLUSIVE", severity=meta["severity"], section=where.split("[")[0],
                                 message=f"'{term}': {meta['reason']}", evidence=text[:160],
                                 suggested_fix=(f"Replace with '{meta['replacement']}'." if meta["replacement"] else "Remove or rephrase."),
                                 auto_fixable=True))

    # vague bullets
    vague = knowledge.lexicon()["vague_markers"]
    for sec in ("responsibilities", "qualifications"):
        for b in jd.get(sec) or []:
            if any(re.search(r"\b" + re.escape(v) + r"\b", b, re.IGNORECASE) for v in vague):
                f.append(Finding(rule_id="R-VAGUE", severity="warning", section=sec, message="Vague wording in bullet.",
                                 evidence=b, suggested_fix="Make it specific: what, for whom, and the outcome.", auto_fixable=True))
            elif len(b.split()) < 3:
                f.append(Finding(rule_id="R-SHORT", severity="info", section=sec, message="Very short bullet; consider adding the outcome or scope.",
                                 evidence=b, suggested_fix="Say what, for whom, and the outcome.", auto_fixable=False))

    # duplicated bullets
    for sec in ("responsibilities", "qualifications"):
        items = jd.get(sec) or []
        for i in range(len(items)):
            for j in range(i + 1, len(items)):
                if _jacc(items[i], items[j]) > 0.75:
                    f.append(Finding(rule_id="R-DUP-ITEM", severity="info", section=sec, message="Near-duplicate bullets.",
                                     evidence=items[j], auto_fixable=True))

    # requirement stack
    if len(skills) > 12:
        f.append(Finding(rule_id="R-STACK-SKILLS", severity="warning", section="skills",
                         message=f"{len(skills)} skills listed; long wish-lists deter qualified applicants.", suggested_fix="Keep the 8-10 that matter most.", auto_fixable=True))
    if len(quals) > 7:
        f.append(Finding(rule_id="R-STACK-QUALS", severity="warning", section="qualifications",
                         message=f"{len(quals)} qualifications; mark non-essential ones as nice to have.", auto_fixable=True))

    # pay transparency + band compliance
    loc = jd.get("location") or ""
    salary = (jd.get("salaryRange") or "").strip()
    band = ((tools.get("get_salary_band") or {}).get("data") or {}).get("band")
    if settings.pay_transparency_required and knowledge.pay_transparency_applies(loc) and not salary:
        f.append(Finding(rule_id="R-PAY-MISSING", severity="error", section="salaryRange",
                         message=f"{loc} requires a salary range in job postings.",
                         suggested_fix=(f"Use the approved band {band['display']}." if band else "Add the base salary range."),
                         auto_fixable=bool(band)))
    if salary and band:
        parsed = knowledge.parse_salary(salary)
        if parsed and (parsed["currency"] in (None, band["currency"])):
            if parsed["min"] < band["min"] * 0.85 or parsed["max"] > band["max"] * 1.15:
                f.append(Finding(rule_id="R-PAY-BAND", severity="warning", section="salaryRange",
                                 message=f"Salary {salary} is outside the approved {band['level']} {band['family']} band ({band['display']}).",
                                 evidence=salary, suggested_fix="Confirm with compensation or align to the band.", auto_fixable=False))
        elif parsed and parsed["currency"] and parsed["currency"] != band["currency"]:
            f.append(Finding(rule_id="R-PAY-CURRENCY", severity="warning", section="salaryRange",
                             message=f"Salary currency {parsed['currency']} doesn't match the location's band currency {band['currency']}.", evidence=salary))

    # duplicate role
    dups = ((tools.get("check_duplicate_role") or {}).get("data") or {}).get("duplicates") or []
    for d in dups[:2]:
        f.append(Finding(rule_id="R-DUP-ROLE", severity="warning", section="title",
                         message=f"Very similar to existing JD \"{d['title']}\" ({d.get('status')}, similarity {d['similarity']}).",
                         suggested_fix="Confirm this is a new headcount rather than a duplicate.", auto_fixable=False))

    # work mode contradictions
    if (jd.get("workMode") == "remote" or loc.lower() == "remote") and re.search(r"relocat|on[- ]site|in[- ]office|5 days (a week )?in", txt_all):
        f.append(Finding(rule_id="R-WORKMODE", severity="warning", section="summary",
                         message="Role is marked remote but text mentions relocation or in-office work."))
    return f


def rubric(jd: dict, findings: list[Finding]) -> dict[str, float]:
    resp, quals = jd.get("responsibilities") or [], jd.get("qualifications") or []
    bullets = resp + quals
    lens = [len(b.split()) for b in bullets] or [0]
    verb_start = sum(1 for b in resp if re.match(r"^[A-Z][a-z]+\b", b) and not re.match(r"^(The|A|An|This|Our|We)\b", b)) / (len(resp) or 1)
    clarity = 2 + 2 * (sum(1 for l in lens if 5 <= l <= 22) / len(lens)) + verb_start
    vague_n = sum(1 for x in findings if x.rule_id == "R-VAGUE") + 0.5 * sum(1 for x in findings if x.rule_id == "R-SHORT")
    specificity = 5 - min(3, vague_n) - (0.5 if len(jd.get("skills") or []) < 3 else 0)
    comp_err = sum(1 for x in findings if x.rule_id.startswith("R-COMPLETE") or x.rule_id.startswith("R-PAY-MISSING"))
    completeness = 5 - min(4, 1.5 * comp_err)
    tone = 3 + (1 if re.search(r"\byou\b|\byou'll\b", jd.get("summary", ""), re.I) else 0) + (1 if verb_start > 0.7 else 0)
    inc = sum({"error": 2, "warning": 1, "info": 0.5}[x.severity] for x in findings if x.rule_id == "R-INCLUSIVE")
    inclusivity = 5 - min(4, inc)
    return {k: round(max(1.0, min(5.0, v)), 2) for k, v in
            {"clarity": clarity, "specificity": specificity, "completeness": completeness, "tone": tone, "inclusivity": inclusivity}.items()}


CRITIC_SYSTEM = """You are a meticulous reviewer of job descriptions before a human sees them.
Score the draft 1-5 on clarity, specificity, completeness, tone and inclusivity.
Report only concrete problems that a hiring manager would want fixed: contradictions, biased or exclusionary language,
unrealistic requirement stacks, vague bullets, claims not supported by the brief. Each finding needs severity,
section, evidence (quote), message and a suggested_fix. Do not repeat issues already listed under deterministic findings."""


def critique(jd: dict, brief: dict, tools: dict) -> Critique:
    ctx = runctx.current()
    rules = rule_findings(jd, tools)
    rb = rubric(jd, rules)
    llm_findings: list[Finding] = []
    if settings.use_llm:
        user = (f"Brief: {json.dumps(brief)[:2500]}\n\nDeterministic findings already raised: "
                f"{json.dumps([r.message for r in rules])[:1500]}\n\n" + as_data("draft", json.dumps(jd, indent=1)))
        try:
            res = llm.structured("critic", Critique, CRITIC_SYSTEM, user, tier="small", max_tokens=1500)
            for x in res.findings:
                x.source = "llm"
                x.auto_fixable = x.severity != "info"
            llm_findings = res.findings[:8]
            if res.rubric:
                rb = {k: round((rb.get(k, 3) + float(v)) / 2, 2) for k, v in res.rubric.items() if k in rb}
        except llm.LLMUnavailable:
            pass
    findings = rules + llm_findings
    passed = not any(x.severity == "error" for x in findings)
    ctx.event("critic", f"{len(findings)} findings ({sum(1 for x in findings if x.severity == 'error')} errors); rubric avg {round(sum(rb.values()) / len(rb), 2)}",
              findings=len(findings), passed=passed)
    return Critique(findings=findings, rubric=rb, passed=passed)


# --------------------------------------------------------------------------- revise (critic loop)

def heuristic_fix(jd: dict, findings: list[Finding], tools: dict) -> tuple[dict, list[str]]:
    jd = json.loads(json.dumps(jd))
    applied: list[str] = []
    lex = knowledge.lexicon()["terms"]
    band = ((tools.get("get_salary_band") or {}).get("data") or {}).get("band")
    rule_ids = {x.rule_id for x in findings if x.auto_fixable}

    def sub_all(fn):
        jd["title"] = fn(jd.get("title", ""))
        jd["summary"] = fn(jd.get("summary", ""))
        for sec in ("responsibilities", "qualifications", "benefits"):
            jd[sec] = [fn(b) for b in jd.get(sec) or []]

    if "R-INCLUSIVE" in rule_ids:
        def repl(text: str) -> str:
            for term, meta in sorted(lex.items(), key=lambda kv: -len(kv[0])):
                pat = re.compile(r"(?<![A-Za-z])" + re.escape(term) + r"(?![A-Za-z])", re.IGNORECASE)
                if pat.search(text):
                    text = pat.sub(meta["replacement"], text)
            text = re.sub(r"\s{2,}", " ", text).replace(" ,", ",").replace("( ", "(").strip()
            text = re.sub(r"\b(a|an)\s+(and|,)", r"\2", text)
            return text[:1].upper() + text[1:] if text else text
        sub_all(repl)
        applied.append("Replaced non-inclusive terms")

    if "R-LEVEL-YEARS" in rule_ids or "R-STACK-IMPOSSIBLE" in rule_ids:
        lo, hi = knowledge.years_for_level(jd.get("level") or "mid")
        def fix_years(text: str) -> str:
            def r(m):
                n = int(m.group(1))
                tech = knowledge.find_skills(m.group(2) or "")
                cap = None
                for s in tech:
                    intro = knowledge.skill_introduced(s)
                    if intro and n > CURRENT_YEAR - intro:
                        cap = max(1, min(CURRENT_YEAR - intro - 2, 5))
                lvl = jd.get("level")
                if lvl in ("intern", "junior") and n >= 3:
                    cap = 0 if lvl == "intern" else 2
                elif lvl == "mid" and n >= 8:
                    cap = hi
                elif lvl in ("senior", "staff", "principal", "director") and n <= 1:
                    return m.group(0).replace(m.group(1), str(lo), 1)
                if cap is None:
                    return m.group(0)
                if cap == 0:
                    return "Relevant coursework or projects" + (" in " + m.group(2).strip() if (m.group(2) or "").strip() else "")
                return re.sub(r"^\d{1,2}(\s*(\+|-\s*\d{1,2}|to\s*\d{1,2}))?", f"0-{cap}" if lvl == "junior" else f"{cap}+", m.group(0), count=1)
            return _YEARS_RE.sub(r, text)
        jd["qualifications"] = [fix_years(q) for q in jd.get("qualifications") or []]
        applied.append("Aligned years of experience with level")

    if "R-VAGUE" in rule_ids:
        vague = knowledge.lexicon()["vague_markers"]
        for sec, minimum in (("responsibilities", 3), ("qualifications", 2)):
            kept = []
            for b in jd.get(sec) or []:
                cleaned = b
                for v in vague:
                    cleaned = re.sub(r",?\s*\b" + re.escape(v) + r"\b\.?", "", cleaned, flags=re.IGNORECASE).strip()
                if len(cleaned.split()) >= 2:
                    kept.append(cleaned.rstrip(",;"))
            if len(kept) >= minimum:
                jd[sec] = kept
        applied.append("Removed vague wording")

    if "R-DUP-ITEM" in rule_ids:
        for sec in ("responsibilities", "qualifications"):
            out: list[str] = []
            for b in jd.get(sec) or []:
                if not any(_jacc(b, o) > 0.75 for o in out):
                    out.append(b)
            jd[sec] = out
        applied.append("Removed duplicate bullets")

    if "R-STACK-SKILLS" in rule_ids:
        jd["skills"] = (jd.get("skills") or [])[:10]
        applied.append("Trimmed skills list to 10")
    if "R-STACK-QUALS" in rule_ids:
        q = jd.get("qualifications") or []
        jd["qualifications"] = q[:5] + [x if "nice to have" in x.lower() else f"{x} (nice to have)" for x in q[5:7]]
        applied.append("Marked extra qualifications as nice to have")
    if "R-PAY-MISSING" in rule_ids and band:
        jd["salaryRange"] = band["display"]
        applied.append(f"Added salary band {band['display']}")
    return jd, applied


def llm_revise(jd: dict, findings: list[Finding], brief: dict) -> Optional[dict]:
    from ..schemas import GeneratedJD

    system = ("You revise job descriptions to resolve reviewer findings. Change only what the findings require; "
              "keep facts from the brief; keep citations/origins of untouched bullets.")
    user = (f"Brief: {json.dumps(brief)[:2000]}\n\nFindings to resolve:\n"
            + "\n".join(f"- [{x.severity}] {x.section}: {x.message} Fix: {x.suggested_fix}" for x in findings if x.severity != "info")
            + "\n\n" + as_data("draft", json.dumps(jd)))
    try:
        res = llm.structured("revise", GeneratedJD, system, user, tier="large", max_tokens=3000)
        return res.flat()
    except llm.LLMUnavailable:
        return None
