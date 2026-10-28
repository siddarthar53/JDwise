from app.agents import ops, qa, reviewer, reviser
from app.rag.store import jd_to_chunks

CATALOG = [{"id": i} for i in ["status_counts", "avg_approval_time", "stuck_jds", "rejection_rate", "throughput", "reviewer_latency", "ai_impact"]]


def test_ops_routing():
    assert ops.heuristic_route("which JDs are stuck waiting on HR?", CATALOG).query_id == "stuck_jds"
    r = ops.heuristic_route("average approval time by department this quarter", CATALOG)
    assert r.query_id == "avg_approval_time" and r.params == {"group_by": "department", "since_days": 90}
    assert ops.heuristic_route("rejection rate per team", CATALOG).query_id == "rejection_rate"


def test_reviser_maps_comment_points(ctx):
    jd = {"title": "Staff Backend Engineer", "level": "staff", "department": "Engineering", "location": "Bangalore", "workMode": "hybrid",
          "summary": "As a Staff Backend Engineer, you'll lead a hybrid team.", "responsibilities": ["Own APIs end to end", "Lead design reviews"],
          "qualifications": ["8+ years of experience"], "skills": ["Go"], "salaryRange": "₹45–70 LPA"}
    p, diff = reviser.revise(jd, "Should be senior, not staff. Also add Terraform as a skill and make it remote.")
    assert p.fields["level"] == "senior" and p.fields["title"] == "Senior Backend Engineer"
    assert "Terraform" in p.fields["skills"] and p.fields["workMode"] == "remote"
    assert p.fields["salaryRange"] == "₹28–45 LPA"  # realigned to the new band
    assert {d["field"] for d in diff} >= {"title", "level", "skills", "workMode"}


def test_reviewer_diff_and_risks(kb, ctx):
    prev = {"title": "Data Analyst", "salaryRange": "", "responsibilities": ["Build dashboards"], "skills": ["SQL"]}
    cur = {"title": "Data Analyst", "level": "mid", "department": "Data", "location": "New York", "salaryRange": "",
           "summary": "As a Data Analyst you'll build dashboards and analyses for the business.",
           "responsibilities": ["Build dashboards", "Run A/B tests", "Write SQL models"], "qualifications": ["2-4 years", "SQL"], "skills": ["SQL", "Tableau"]}
    rep = reviewer.review(cur, prev, "pending_hr", "please add salary")
    assert any("Run A/B tests" in c for c in rep.changes)
    assert any(r.rule_id == "R-PAY-MISSING" for r in rep.risks)
    assert rep.recommendation == "request_changes"


def test_qa_refuses_without_permitted_evidence(kb, ctx):
    kb.upsert_doc("j1", jd_to_chunks({"_id": "j1", "title": "Marketing Specialist", "status": "approved", "summary": "Runs campaigns", "salaryRange": "x",
                                      "responsibilities": ["Run campaigns"], "qualifications": [], "skills": ["SEO"]}))
    a = qa.answer("what is the salary for the marketing specialist?", allowed_jd_ids=[], allowed_conversations=[])
    assert a.refused
    a2 = qa.answer("which roles need SEO?", allowed_jd_ids=["j1"], allowed_conversations=[],
                   jd_index=[{"id": "j1", "title": "Marketing Specialist", "status": "approved", "skills": ["SEO"], "qualifications": []}])
    assert "Marketing Specialist" in a2.answer
