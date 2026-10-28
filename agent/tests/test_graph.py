from langgraph.types import Command

from app.graph.draft_graph import get_graph


def _run(g, cfg, inp):
    return g.invoke(inp, cfg)


def test_end_to_end_draft_with_interrupts(kb, ctx):
    g = get_graph()
    cfg = {"configurable": {"thread_id": "t-e2e"}}
    r = _run(g, cfg, {"messages": [{"role": "user", "content": "need a mid-level data analyst for the Data team"}], "existing": {}, "org": {}, "prefs": {}, "jd_id": "x"})
    assert r["__interrupt__"][0].value["type"] == "question"
    r = _run(g, cfg, Command(resume="They will build dashboards, write SQL and run experiments"))
    q = r.get("__interrupt__")
    while q and q[0].value["type"] == "question":
        r = _run(g, cfg, Command(resume="full-time, hybrid in Hyderabad"))
        q = r.get("__interrupt__")
    if q:
        assert q[0].value["type"] == "review"
        r = _run(g, cfg, Command(resume="looks good"))
    final = r["final"]
    f = final["fields"]
    assert f["title"] and len(f["responsibilities"]) >= 3 and len(f["qualifications"]) >= 2
    assert any(b["citations"] for b in final["bullets"]["responsibilities"]), "draft should cite retrieved evidence"
    assert final["sources"]
    assert not [x for x in final["critique"]["findings"] if x["severity"] == "error"]


def test_critic_loop_fixes_brief_problems(kb, ctx):
    g = get_graph()
    cfg = {"configurable": {"thread_id": "t-critic"}}
    msg = ("Hiring a junior frontend developer, engineering team, full-time, remote. They will build React components. "
           "Requirements:\n- 6+ years of React experience\n- rockstar attitude")
    r = _run(g, cfg, {"messages": [{"role": "user", "content": msg}], "existing": {}, "org": {}, "prefs": {}, "jd_id": "y"})
    while r.get("__interrupt__"):
        r = _run(g, cfg, Command(resume="looks good" if r["__interrupt__"][0].value["type"] == "review" else "React, TypeScript"))
    text = " ".join(r["final"]["fields"]["qualifications"]).lower()
    assert "6+ years" not in text and "rockstar" not in text
    assert r["final"]["fixes_applied"]


def test_refinement_regenerates_without_reinterview(kb, ctx):
    g = get_graph()
    cfg = {"configurable": {"thread_id": "t-refine"}}
    r = _run(g, cfg, {"messages": [{"role": "user", "content": "Hiring a mid-level product designer in the Design team, full-time, remote. They will run user research and design flows in Figma."}],
                      "existing": {}, "org": {}, "prefs": {}, "jd_id": "z"})
    while r.get("__interrupt__"):
        r = _run(g, cfg, Command(resume="looks good"))
    r = _run(g, cfg, {"messages": [{"role": "user", "content": "make it senior"}], "existing": r["final"]["fields"], "org": {}, "prefs": {}, "jd_id": "z"})
    while r.get("__interrupt__"):
        assert r["__interrupt__"][0].value["type"] == "review"
        r = _run(g, cfg, Command(resume="looks good"))
    assert r["final"]["fields"]["level"] == "senior" and "Senior" in r["final"]["fields"]["title"]
