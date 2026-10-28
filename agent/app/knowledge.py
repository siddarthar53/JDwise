"""Static company knowledge: skills taxonomy, compensation bands, inclusive
lexicon, level conventions. Loaded once from agent/data/."""
from __future__ import annotations

import json
import re
from functools import lru_cache
from typing import Optional

from .config import DATA_DIR

LEVEL_YEARS = {
    "intern": (0, 0), "junior": (0, 2), "mid": (2, 5), "senior": (5, 8), "staff": (8, 12),
    "principal": (10, 15), "lead": (6, 10), "manager": (6, 10), "director": (10, 15),
}
LEVEL_LABEL = {
    "intern": "Intern", "junior": "Junior", "mid": "Mid-level", "senior": "Senior", "staff": "Staff",
    "principal": "Principal", "lead": "Lead", "manager": "Manager", "director": "Director",
}

DEPARTMENT_KEYWORDS = [
    ("Engineering", ["engineer", "developer", "devops", "sre", "backend", "frontend", "full stack", "fullstack", "software", "programmer", "qa ", "architect", "platform"]),
    ("Data", ["data scientist", "data analyst", "analytics", "machine learning", "ml engineer", "data engineer", "ai engineer", "bi analyst"]),
    ("Design", ["designer", "ux", "ui ", "product design", "researcher"]),
    ("Product", ["product manager", "product owner", "pm "]),
    ("Marketing", ["marketing", "marketer", "seo", "content", "brand", "growth", "copywriter", "social media"]),
    ("Sales", ["sales", "account executive", "business development", "bdr", "sdr"]),
    ("Customer Success", ["customer success", "support", "account manager"]),
    ("People Ops", ["recruiter", "hr ", "human resources", "people", "talent", "hrbp"]),
    ("Finance", ["finance", "financial", "accountant", "accounting", "fp&a", "controller"]),
    ("Operations", ["operations", "ops manager", "office manager", "logistics"]),
]


@lru_cache(maxsize=1)
def taxonomy() -> dict:
    return json.loads((DATA_DIR / "skills_taxonomy.json").read_text())


@lru_cache(maxsize=1)
def _alias_index() -> list[tuple[re.Pattern, str]]:
    idx = []
    for canon, aliases in taxonomy()["skills"].items():
        for a in set(aliases + [canon.lower()]):
            # word-boundary match; escape regex chars (c++, c#, .net, ci/cd)
            pat = re.compile(r"(?<![A-Za-z0-9])" + re.escape(a) + r"(?![A-Za-z0-9+#])", re.IGNORECASE)
            idx.append((pat, canon))
    # longer aliases first so "react native"/"spring boot" win over shorter ones
    idx.sort(key=lambda t: -len(t[0].pattern))
    return idx


AMBIGUOUS_ALIASES = {"go", "ts", "tf", "py", "rest", "ml", "dl", "sem", "stats", "spring", "node", "sketch", "swift", "rust", "excel", "communication", "testing", "security", "architecture"}


def find_skills(text: str) -> list[str]:
    """Extract canonical skills mentioned in free text."""
    found: list[str] = []
    if not text:
        return found
    for pat, canon in _alias_index():
        alias = pat.pattern
        m = pat.search(text)
        if not m:
            continue
        raw = m.group(0).lower()
        if raw in AMBIGUOUS_ALIASES:
            # require a tech-ish context for very short/ambiguous aliases
            ctx = text[max(0, m.start() - 40): m.end() + 40].lower()
            if not re.search(r"skill|stack|experience|know|using|with|in |proficien|languages?|tools?|,", ctx):
                continue
            if raw == "go" and not re.search(r"\bgo(lang)?\b\s*(,|and|/|\)|developer|engineer|services?|programming)|golang|\b(python|java|rust|typescript),?\s+(and\s+)?go\b", text, re.IGNORECASE):
                continue
        if canon not in found:
            found.append(canon)
    return found


def normalize_skills(items: list[str]) -> tuple[list[str], list[dict]]:
    """Map free-form skill strings to canonical names. Returns (skills, mapping log)."""
    out: list[str] = []
    log: list[dict] = []
    alias_map = {}
    for canon, aliases in taxonomy()["skills"].items():
        alias_map[canon.lower()] = canon
        for a in aliases:
            alias_map[a.lower()] = canon
    for raw in items:
        key = raw.strip().lower().rstrip(".")
        key2 = re.sub(r"\s*\(nice to have\)\s*", "", key)
        canon = alias_map.get(key2)
        if not canon:
            hits = find_skills(raw)
            canon = hits[0] if len(hits) == 1 and len(raw) < 40 else None
        final = canon or raw.strip()
        if final.lower() not in {s.lower() for s in out}:
            out.append(final)
        log.append({"input": raw, "output": final, "matched": bool(canon)})
    return out, log


def skill_introduced(skill: str) -> Optional[int]:
    return taxonomy().get("introduced", {}).get(skill)


@lru_cache(maxsize=1)
def bands() -> dict:
    return json.loads((DATA_DIR / "salary_bands.json").read_text())


def region_for(location: str) -> Optional[str]:
    loc = (location or "").lower()
    if not loc:
        return None
    for region, meta in bands()["regions"].items():
        if any(re.search(r"\b" + re.escape(c) + r"\b", loc) for c in meta["cities"]):
            return region
    return None


def family_for(department: str, title: str = "") -> str:
    d = (department or "").strip().lower()
    fam = bands()["department_family"]
    if d in fam:
        return fam[d]
    for k, v in fam.items():
        if k in d:
            return v
    inferred = infer_department(title)
    if inferred:
        return fam.get(inferred.lower(), "operations")
    return "operations"


def salary_band(department: str, level: str, location: str, title: str = "") -> Optional[dict]:
    region = region_for(location)
    if not region or not level:
        return None
    family = family_for(department, title)
    table = bands()["families"].get(family, {}).get(region, {})
    rng = table.get(level)
    if not rng:
        return None
    meta = bands()["regions"][region]
    return {"family": family, "region": region, "level": level, "min": rng[0], "max": rng[1],
            "currency": meta["currency"], "unit": meta["unit"], "display": format_band(rng[0], rng[1], meta["currency"], meta["unit"])}


def format_band(lo: float, hi: float, currency: str, unit: str) -> str:
    def fmt(x: float) -> str:
        return f"{x:g}"
    if currency == "INR":
        return f"₹{fmt(lo)}–{fmt(hi)} LPA"
    sym = {"USD": "$", "GBP": "£", "EUR": "€"}.get(currency, currency + " ")
    return f"{sym}{int(lo * 1000):,} – {sym}{int(hi * 1000):,}"


def parse_salary(text: str) -> Optional[dict]:
    """Parse '$120k-150k', '₹25-35 LPA', '120,000 - 150,000 USD' into band units."""
    if not text:
        return None
    t = text.replace(",", "").lower()
    cur = None
    if "₹" in t or "inr" in t or "lpa" in t or "lakh" in t:
        cur = "INR"
    elif "£" in t or "gbp" in t:
        cur = "GBP"
    elif "€" in t or "eur" in t:
        cur = "EUR"
    elif "$" in t or "usd" in t:
        cur = "USD"
    nums = re.findall(r"(\d+(?:\.\d+)?)\s*(k|lpa|l|lakhs?|m)?", t)
    vals = []
    for n, suf in nums:
        v = float(n)
        if suf == "k":
            v = v  # already thousands
        elif suf == "m":
            v = v * 1000
        elif cur in (None, "USD", "GBP", "EUR") and v >= 1000:
            v = v / 1000.0
        vals.append(v)
    vals = [v for v in vals if v > 0]
    if not vals:
        return None
    lo, hi = (vals[0], vals[1]) if len(vals) >= 2 else (vals[0], vals[0])
    if lo > hi:
        lo, hi = hi, lo
    return {"min": lo, "max": hi, "currency": cur}


def pay_transparency_applies(location: str) -> bool:
    loc = (location or "").lower()
    return any(re.search(r"\b" + re.escape(c) + r"\b", loc) for c in bands()["pay_transparency_locations"])


@lru_cache(maxsize=1)
def lexicon() -> dict:
    return json.loads((DATA_DIR / "inclusive_lexicon.json").read_text())


@lru_cache(maxsize=1)
def role_library() -> list[dict]:
    return json.loads((DATA_DIR / "role_library.json").read_text())


@lru_cache(maxsize=1)
def style_guide() -> str:
    return (DATA_DIR / "style_guide.md").read_text()


def infer_department(title: str) -> Optional[str]:
    t = f" {(title or '').lower()} "
    for dept, kws in DEPARTMENT_KEYWORDS:
        if any(k in t for k in kws):
            return dept
    return None


def infer_level(text: str) -> Optional[str]:
    t = (text or "").lower()
    rules = [
        ("intern", r"\bintern(ship)?\b"),
        ("principal", r"\bprincipal\b"),
        ("staff", r"\bstaff\b(?! (augmentation|members?))"),
        ("director", r"\b(director|head of|vp)\b"),
        ("manager", r"\b(engineering|design|people|hr|finance|data science|analytics) manager\b|\bmanager of\b|\bpeople manager\b"),
        ("lead", r"\b(tech|team) lead\b|\blead [a-z]+ (engineer|designer|developer|analyst)\b"),
        ("senior", r"\b(senior|sr\.?)\b"),
        ("junior", r"\b(junior|jr\.?|entry[- ]level|graduate|fresher|new grad|early[- ]career)\b"),
        ("mid", r"\b(mid[- ]level|intermediate|ii\b|level 2|l4\b)"),
    ]
    for lvl, pat in rules:
        if re.search(pat, t):
            return lvl
    return None


def years_for_level(level: str) -> tuple[int, int]:
    return LEVEL_YEARS.get(level or "mid", (2, 5))
