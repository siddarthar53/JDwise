from app import services
from app.rag.retriever import Filters
from app.rag.store import jd_to_chunks, message_chunk
from app.schemas import ToolCall
from app.tools import execute


def _add_jd(kb, _id, title, status="approved", **kw):
    d = {"_id": _id, "title": title, "status": status, "department": kw.get("department", "Engineering"), "level": kw.get("level", "mid"),
         "summary": kw.get("summary", f"{title} builds things."), "responsibilities": kw.get("responsibilities", ["Build APIs in Go"]),
         "qualifications": ["3 years experience"], "skills": kw.get("skills", ["Go"])}
    kb.upsert_doc(_id, jd_to_chunks(d))


def test_hybrid_retrieval_finds_exact_skill(kb):
    _add_jd(kb, "j1", "Go Platform Engineer", responsibilities=["Build gRPC services in Go", "Own Kubernetes deployments"])
    hits = services.get_retriever().search("kubernetes deployments", k=3, filters=Filters(doc_types=["jd"]))
    assert hits and hits[0]["chunk"]["doc_id"] == "j1"


def test_permission_filter_blocks_unauthorised_docs(kb):
    _add_jd(kb, "secret", "Confidential Director Role", summary="Confidential reorg for the payments org")
    kb.upsert_doc("conv:c9", [message_chunk({"id": "m1", "conversation_id": "c9", "participants": ["a", "b"], "content": "the reorg is confidential"})])
    f = Filters(doc_types=["jd", "message"], allowed_doc_ids=set(), allowed_conversations={"c1"})
    assert services.get_retriever().search("confidential reorg", filters=f) == []


def test_tool_allow_list_and_arg_validation(kb, ctx):
    assert execute(ToolCall(tool="get_salary_band", args={"level": "senior", "location": "Bangalore", "department": "Engineering"}), {}, node="tools")["ok"]
    assert not execute(ToolCall(tool="get_salary_band", args={"level": "senior"}), {}, node="tools")["ok"]   # missing location
    assert not execute(ToolCall(tool="find_similar_jds", args={"role": "x"}), {}, node="reviser")["ok"]       # not allowed in node
    assert not execute(ToolCall(tool="approve_jd", args={}), {}, node="tools")["ok"]                         # no such tool


def test_tool_idempotency_cache(kb, ctx):
    cache = {}
    call = ToolCall(tool="normalize_skills", args={"skills": ["reactjs", "k8s"]})
    a = execute(call, {}, cache=cache)
    b = execute(call, {}, cache=cache)
    assert a == b and a["data"]["skills"] == ["React", "Kubernetes"]
    assert ctx.tool_calls[-1]["cached"] is True


def test_duplicate_role_detection(kb, ctx):
    _add_jd(kb, "dup1", "Senior Data Analyst", status="pending_hr", department="Data", summary="Senior Data Analyst owning dashboards")
    r = execute(ToolCall(tool="check_duplicate_role", args={"title": "Senior Data Analyst", "summary": "dashboards"}), {}, node="tools")
    assert r["ok"] and r["data"]["duplicates"] and r["data"]["duplicates"][0]["doc_id"] == "dup1"
