from app.agents.intake import heuristic_extract, merge, missing_fields, next_question, apply_directives
from app.schemas import Brief


def test_extracts_full_brief_from_one_message():
    b, c = heuristic_extract("We're hiring a senior backend engineer for the platform team in Bangalore, full-time, hybrid. "
                             "They will own our payments APIs and mentor juniors. Must know Go, Postgres and Kubernetes. Budget 35-45 LPA.")
    assert b.title == "Senior Backend Engineer"
    assert b.level == "senior" and b.department == "Platform"
    assert b.location == "Bangalore" and b.workMode == "hybrid" and b.employmentType == "Full-time"
    assert {"Go", "PostgreSQL", "Kubernetes"} <= set(b.skills)
    assert "Own our payments APIs" in b.responsibilities
    assert b.salaryRange.startswith("35-45")
    assert not missing_fields(b, c)


def test_short_answer_fills_the_asked_slot():
    b, c = heuristic_extract("Marketing", asked="department")
    assert b.department == "Marketing" and c["department"] >= 0.8


def test_asks_only_what_is_missing():
    b, c = heuristic_extract("need a data analyst")
    field, _ = next_question(b, c, [])
    assert field == "level"  # title known, department inferred from title


def test_parses_pasted_jd_sections():
    text = "Title: Staff ML Engineer\nDepartment: Data\n\nResponsibilities:\n- Build LLM evaluation pipelines\n- Lead RAG architecture\n\nRequirements:\n- 8+ years ML experience\n- Strong Python"
    b, _ = heuristic_extract(text)
    assert b.title == "Staff ML Engineer" and b.level == "staff"
    assert b.responsibilities[:2] == ["Build LLM evaluation pipelines", "Lead RAG architecture"]
    assert "Strong Python" in b.qualifications


def test_directive_same_but_senior():
    b = Brief(title="Data Analyst", level="mid", department="Data")
    c = {"title": 0.9, "level": 0.9}
    apply_directives("make this one but for Senior", b, c)
    assert b.level == "senior" and b.title == "Senior Data Analyst"


def test_merge_keeps_confident_values():
    prev = Brief(title="Product Designer", department="Design")
    prev_c = {"title": 0.95, "department": 0.95}
    new, new_c = heuristic_extract("we also need figma skills")
    merged, mc = merge(prev, prev_c, new, new_c)
    assert merged.title == "Product Designer" and "Figma" in merged.skills
