"""Layer 7 — revision agent: turn a reviewer's rejection comment into concrete
edits. Output is a *proposal* with a diff; the owner must confirm before the
API applies it and before anything is re-submitted."""
from __future__ import annotations

import json
import re

from .. import knowledge, llm, runctx
from ..guard import as_data, neutralize
from ..schemas import Finding, GeneratedJD, RevisionProposal
from . import critic
from .reviewer import diff_versions

EDITABLE = ["title", "department", "level", "employmentType", "location", "workMode", "salaryRange", "summary",
            "responsibilities", "qualifications", "skills"]


_ACTION = r"(?:make|add|remove|drop|delete|set|change|include|use|reduce|trim|rewrite|rephrase|mention|move|update)"


def _split_points(comment: str) -> list[str]:
    parts = re.split(r"(?:\n|;|\.\s+|\b(?:and\s+)?also\b,?|,?\s+and\s+(?=" + _ACTION + r"\b)|(?<=\w)\.$)", comment, flags=re.IGNORECASE)
    return [p.strip(" .,-") for p in parts if p and len(p.strip()) > 3]


def heuristic_revise(jd: dict, comment: str) -> RevisionProposal:
    new = json.loads(json.dumps({k: jd.get(k) for k in EDITABLE}))
    for k in ("responsibilities", "qualifications", "skills"):
        new[k] = list(new.get(k) or [])
    addressed, unresolved = [], []
    band = knowledge.salary_band(jd.get("department", ""), jd.get("level", ""), jd.get("location", ""), jd.get("title", ""))

    for point in _split_points(comment):
        p = point.lower()
        handled = False
        m = re.search(r"\b(intern|junior|mid(?:-level)?|senior|staff|principal|lead)\b", p)
        if m and re.search(r"level|senior|junior|staff|should be|make it|more|less|downlevel|uplevel", p):
            lvl = knowledge.infer_level(m.group(1)) or m.group(1).replace("-level", "")
            if lvl in knowledge.LEVEL_YEARS and lvl != new.get("level"):
                new["level"] = lvl
                base = re.sub(r"\b(senior|sr\.?|junior|jr\.?|staff|principal|lead)\b\s*", "", new["title"] or "", flags=re.I).strip()
                base = re.sub(r"\s+(i{1,3}|iv)$", "", base, flags=re.I).strip()
                prefix = {"junior": "Junior", "senior": "Senior", "staff": "Staff", "principal": "Principal", "lead": "Lead"}.get(lvl, "")
                old_title = new["title"]
                new["title"] = f"{prefix} {base}".strip()
                if old_title and new.get("summary"):
                    new["summary"] = new["summary"].replace(old_title, new["title"])
                lo, hi = knowledge.years_for_level(lvl)
                yrs = f"0-2" if lvl == "junior" else f"{lo}-{hi}" if lvl == "mid" else f"{lo}+"
                new["qualifications"] = [re.sub(r"^\d{1,2}(\s*(\+|-\s*\d{1,2}))?\s*years", f"{yrs} years", q) for q in new["qualifications"]]
                band = knowledge.salary_band(new.get("department", ""), lvl, new.get("location", ""), new.get("title", ""))
                note = ""
                cur = knowledge.parse_salary(new.get("salaryRange") or "")
                if band and (not cur or cur["min"] < band["min"] * 0.85 or cur["max"] > band["max"] * 1.15):
                    new["salaryRange"] = band["display"]
                    note = f"; salary realigned to the {lvl} band {band['display']}"
                addressed.append(f"Changed level to {lvl} and aligned title/experience{note} (\"{point}\")")
                handled = True
        if re.search(r"salary|pay|compensation|band|range", p):
            sal = knowledge.parse_salary(point)
            nums = re.findall(r"\d", point)
            if sal and nums:
                mm = re.search(r"[$₹£€]?\s?\d[\d,.]*\s*[kKmM]?\s*(?:-|to|–)\s*[$₹£€]?\s?\d[\d,.]*\s*[kKmM]?(?:\s*(?:lpa|LPA))?", point)
                new["salaryRange"] = mm.group(0).strip() if mm else point
                addressed.append(f"Set salary to {new['salaryRange']}")
                handled = True
            elif band:
                new["salaryRange"] = band["display"]
                addressed.append(f"Set salary to the approved band {band['display']}")
                handled = True
        if re.search(r"too many|reduce|trim|shorter|wish ?list|fewer", p):
            if "skill" in p or "requirement" in p or "qualification" in p or "wish" in p:
                new["skills"] = new["skills"][:8]
                new["qualifications"] = new["qualifications"][:5]
                addressed.append("Trimmed skills to 8 and qualifications to 5")
                handled = True
        if re.search(r"vague|specific|generic|clearer|unclear", p):
            fixed, applied = critic.heuristic_fix(new, critic.rule_findings(new), {})
            removed = [b for b in new["responsibilities"] if len(b.split()) < 4]
            fixed["responsibilities"] = [b for b in fixed["responsibilities"] if len(b.split()) >= 4] or fixed["responsibilities"]
            new.update(fixed)
            addressed.append("Removed vague/short bullets" + (f" ({len(removed)})" if removed else ""))
            handled = True
        if re.search(r"inclusive|bias|biased|gender|language|tone|rockstar|ninja", p):
            fixed, applied = critic.heuristic_fix(new, [Finding(rule_id="R-INCLUSIVE", severity="warning", section="all", message="", auto_fixable=True)], {})
            new.update(fixed)
            addressed.append("Rewrote non-inclusive wording")
            handled = True
        add = re.search(r"\b(?:add|include|mention)\b\s+(?:a\s+|an\s+)?(?:requirement|skill|bullet|responsibilit(?:y|ies))?\s*(?:for|about|on|:)?\s*(.+)", point, re.I)
        if add and not handled:
            item = add.group(1).strip().rstrip(".")
            as_skill = bool(re.search(r"\bas (?:a |an )?(?:skill|requirement)s?\b|\bskills?\b", item, re.I))
            item = re.sub(r"\s*\bas (?:a |an )?(?:skill|requirement)s?\b|\s*\bto the skills?( list)?\b", "", item, flags=re.I).strip()
            skills = knowledge.find_skills(item)
            if (skills or as_skill) and len(item.split()) <= 4:
                skills = skills or [item]
                for s in skills:
                    if s not in new["skills"]:
                        new["skills"].append(s)
                addressed.append(f"Added skill(s): {', '.join(skills)}")
            elif re.search(r"responsib|own|lead|manage|build", point, re.I):
                new["responsibilities"].append(item[:1].upper() + item[1:])
                addressed.append(f"Added responsibility: {item}")
            else:
                new["qualifications"].append(item[:1].upper() + item[1:])
                addressed.append(f"Added qualification: {item}")
            handled = True
        rem = re.search(r"\b(remove|drop|delete|no need for|don'?t need)\b\s+(?:the\s+)?(.+)", point, re.I)
        if rem and not handled:
            target = rem.group(2).strip().rstrip(".").lower()
            key = [w for w in re.findall(r"[a-z0-9+#.]+", target) if len(w) > 2 and w not in ("requirement", "bullet", "line", "skill", "about")]
            before = sum(len(new[k]) for k in ("responsibilities", "qualifications", "skills"))
            for k in ("responsibilities", "qualifications", "skills"):
                new[k] = [x for x in new[k] if not (key and all(w in x.lower() for w in key[:2]))]
            if sum(len(new[k]) for k in ("responsibilities", "qualifications", "skills")) < before:
                addressed.append(f"Removed items mentioning '{' '.join(key[:2])}'")
                handled = True
        if re.search(r"remote|hybrid|on[- ]?site|in[- ]office", p) and not handled:
            mode = "remote" if "remote" in p else "hybrid" if "hybrid" in p else "onsite"
            if new.get("workMode") and new.get("summary"):
                new["summary"] = re.sub(r"\b" + re.escape(new["workMode"]) + r"\b", mode, new["summary"])
            new["workMode"] = mode
            addressed.append(f"Set work mode to {mode}")
            handled = True
        if not handled:
            unresolved.append(point)
    return RevisionProposal(fields=new, addressed=addressed, unresolved=unresolved,
                            explanation="Rule-based revision of the reviewer's comment." if addressed else "I couldn't map this comment to specific edits.")


REVISE_SYSTEM = """A reviewer rejected a job description with a comment. Propose the minimal edits that fully address it.
Return the complete updated fields (title, department, level, employmentType, location, workMode, salaryRange, summary,
responsibilities, qualifications, skills). In `addressed`, list each point of the comment and how you handled it.
In `unresolved`, list points that need the author's input (e.g. facts you don't have). Do not invent facts."""


def revise(jd: dict, comment: str) -> tuple[RevisionProposal, list[dict]]:
    ctx = runctx.current()
    clean, injected = neutralize(comment)
    if injected:
        ctx.event("guard", "Instruction-like text in rejection comment was neutralised")
    proposal = None
    try:
        user = as_data("rejection_comment", clean) + "\n\n" + as_data("jd", json.dumps({k: jd.get(k) for k in EDITABLE}, default=str))
        res = llm.structured("revise_rejection", RevisionProposal, REVISE_SYSTEM, user, tier="large", max_tokens=2500)
        fields = {k: res.fields.get(k, jd.get(k)) for k in EDITABLE}
        # schema check of the proposed JD
        GeneratedJD.model_validate({**fields, "responsibilities": [{"text": t} for t in fields["responsibilities"] or []],
                                    "qualifications": [{"text": t} for t in fields["qualifications"] or []]})
        proposal = RevisionProposal(fields=fields, addressed=res.addressed, unresolved=res.unresolved, explanation=res.explanation)
    except llm.LLMUnavailable:
        pass
    except Exception as e:  # invalid proposal from the model → deterministic fallback
        ctx.event("revise", f"LLM proposal rejected by schema: {str(e)[:120]}")
    if proposal is None:
        proposal = heuristic_revise(jd, clean)
    diff = diff_versions({k: jd.get(k) for k in EDITABLE}, proposal.fields)
    ctx.event("revise", f"Proposed {len(diff)} edits; {len(proposal.unresolved)} points need the author")
    return proposal, diff
