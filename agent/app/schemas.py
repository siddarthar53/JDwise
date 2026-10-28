"""Pydantic schemas. Every LLM output is validated against one of these before it
leaves the agent service (and Express validates again before writing to Mongo)."""
from __future__ import annotations

from typing import Any, Literal, Optional

from pydantic import BaseModel, Field, field_validator

LEVELS = ["intern", "junior", "mid", "senior", "staff", "principal", "lead", "manager", "director"]
WORK_MODES = ["onsite", "hybrid", "remote"]
EMPLOYMENT_TYPES = ["Full-time", "Part-time", "Contract", "Internship", "Temporary"]

BRIEF_FIELDS = [
    "title", "department", "level", "employmentType", "location", "workMode",
    "yearsExperience", "salaryRange", "skills", "responsibilities", "qualifications", "benefits", "summaryHint",
]
REQUIRED_BRIEF_FIELDS = ["title", "department", "level", "employmentType", "responsibilities"]


def _clean_list(v: Any) -> list[str]:
    if v is None:
        return []
    if isinstance(v, str):
        v = [v]
    out, seen = [], set()
    for item in v:
        s = str(item).strip().strip("-•* ").strip()
        if s and s.lower() not in seen:
            seen.add(s.lower())
            out.append(s)
    return out


class Brief(BaseModel):
    """What the intake agent has learned about the role so far."""
    title: str = ""
    department: str = ""
    level: str = ""
    employmentType: str = ""
    location: str = ""
    workMode: str = ""
    yearsExperience: str = ""
    salaryRange: str = ""
    skills: list[str] = Field(default_factory=list)
    responsibilities: list[str] = Field(default_factory=list)
    qualifications: list[str] = Field(default_factory=list)
    benefits: list[str] = Field(default_factory=list)
    summaryHint: str = ""
    notes: list[str] = Field(default_factory=list)

    _lists = field_validator("skills", "responsibilities", "qualifications", "benefits", "notes", mode="before")(_clean_list)

    @field_validator("level", mode="before")
    @classmethod
    def _level(cls, v: Any) -> str:
        v = (v or "").strip().lower()
        return v if v in LEVELS or v == "" else ""

    @field_validator("workMode", mode="before")
    @classmethod
    def _mode(cls, v: Any) -> str:
        v = (v or "").strip().lower().replace("on-site", "onsite").replace("in-office", "onsite")
        return v if v in WORK_MODES or v == "" else ""


class IntakeResult(BaseModel):
    brief: Brief
    confidence: dict[str, float] = Field(default_factory=dict)
    missing_fields: list[str] = Field(default_factory=list)
    next_question: Optional[str] = None
    ready: bool = False

    @field_validator("confidence", mode="before")
    @classmethod
    def _conf(cls, v: Any) -> dict[str, float]:
        out = {}
        for k, val in (v or {}).items():
            try:
                out[k] = max(0.0, min(1.0, float(val)))
            except (TypeError, ValueError):
                continue
        return out


class Bullet(BaseModel):
    text: str
    origin: Literal["brief", "retrieved", "generated", "memory", "tool"] = "generated"
    citations: list[str] = Field(default_factory=list)  # kb chunk ids

    @field_validator("text")
    @classmethod
    def _t(cls, v: str) -> str:
        v = v.strip().strip("-•* ").strip()
        if not v:
            raise ValueError("empty bullet")
        return v


class GeneratedJD(BaseModel):
    title: str = Field(min_length=2)
    department: str = ""
    level: str = ""
    employmentType: str = "Full-time"
    location: str = ""
    workMode: str = ""
    salaryRange: str = ""
    summary: str = Field(min_length=20)
    responsibilities: list[Bullet] = Field(min_length=3, max_length=10)
    qualifications: list[Bullet] = Field(min_length=2, max_length=10)
    skills: list[str] = Field(min_length=1, max_length=20)
    benefits: list[str] = Field(default_factory=list)

    _skills = field_validator("skills", "benefits", mode="before")(_clean_list)

    def flat(self) -> dict[str, Any]:
        return {
            "title": self.title,
            "department": self.department,
            "level": self.level,
            "employmentType": self.employmentType,
            "location": self.location,
            "workMode": self.workMode,
            "salaryRange": self.salaryRange,
            "summary": self.summary,
            "responsibilities": [b.text for b in self.responsibilities],
            "qualifications": [b.text for b in self.qualifications],
            "skills": list(self.skills),
            "benefits": list(self.benefits),
        }


Severity = Literal["info", "warning", "error"]


class Finding(BaseModel):
    rule_id: str
    severity: Severity
    section: str
    message: str
    evidence: str = ""
    suggested_fix: str = ""
    source: Literal["rule", "llm"] = "rule"
    auto_fixable: bool = False


class Critique(BaseModel):
    findings: list[Finding] = Field(default_factory=list)
    rubric: dict[str, float] = Field(default_factory=dict)  # clarity, specificity, completeness, tone, inclusivity (1-5)
    passed: bool = True

    @property
    def score(self) -> float:
        return round(sum(self.rubric.values()) / len(self.rubric), 2) if self.rubric else 0.0


class ToolCall(BaseModel):
    tool: str
    args: dict[str, Any] = Field(default_factory=dict)


class ToolPlan(BaseModel):
    calls: list[ToolCall] = Field(default_factory=list)


class ReviewReport(BaseModel):
    summary: str
    changes: list[str] = Field(default_factory=list)
    risks: list[Finding] = Field(default_factory=list)
    suggested_comments: list[str] = Field(default_factory=list)
    recommendation: Literal["approve", "request_changes", "needs_discussion"] = "approve"


class RevisionProposal(BaseModel):
    fields: dict[str, Any]
    addressed: list[str] = Field(default_factory=list)   # how each comment point was handled
    unresolved: list[str] = Field(default_factory=list)
    explanation: str = ""


class QAAnswer(BaseModel):
    answer: str
    citations: list[dict[str, Any]] = Field(default_factory=list)
    refused: bool = False


class OpsRoute(BaseModel):
    query_id: str
    params: dict[str, Any] = Field(default_factory=dict)
    rationale: str = ""
