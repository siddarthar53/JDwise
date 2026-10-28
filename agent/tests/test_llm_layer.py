"""LLM layer with a fake client: validation repair, model fallback, final fallback, budgets."""
from types import SimpleNamespace

import pytest

from app import config, llm
from app.schemas import OpsRoute


class FakeClient:
    def __init__(self, outputs):
        self.outputs = list(outputs)
        self.calls = []
        self.messages = self

    def create(self, **kw):
        self.calls.append(kw)
        out = self.outputs.pop(0)
        if isinstance(out, Exception):
            raise out
        return SimpleNamespace(content=[SimpleNamespace(type="tool_use", input=out)],
                               usage=SimpleNamespace(input_tokens=100, output_tokens=20, cache_read_input_tokens=50))


@pytest.fixture()
def llm_on(monkeypatch):
    monkeypatch.setenv("LLM_PROVIDER", "anthropic")
    monkeypatch.setenv("LLM_MAX_RETRIES", "1")
    config.reload_settings()
    yield
    monkeypatch.setenv("LLM_PROVIDER", "heuristic")
    config.reload_settings()
    llm.set_client(None)


def test_valid_first_try(llm_on, ctx):
    fake = FakeClient([{"query_id": "status_counts", "params": {}}])
    llm.set_client(fake)
    r = llm.structured("ops_route", OpsRoute, "sys", "q", tier="small")
    assert r.query_id == "status_counts"
    assert fake.calls[0]["tool_choice"]["type"] == "tool"
    assert fake.calls[0]["system"][0]["cache_control"] == {"type": "ephemeral"}
    assert ctx.input_tokens == 100 and ctx.cache_read_tokens == 50 and ctx.cost_usd > 0


def test_repair_after_validation_error(llm_on, ctx):
    fake = FakeClient([{"wrong": 1}, {"query_id": "throughput"}])
    llm.set_client(fake)
    r = llm.structured("ops_route", OpsRoute, "sys", "q")
    assert r.query_id == "throughput" and ctx.validation_errors == 1
    assert "failed validation" in fake.calls[1]["messages"][-1]["content"]


def test_falls_back_to_other_model_then_raises(llm_on, ctx):
    fake = FakeClient([RuntimeError("503"), RuntimeError("503"), RuntimeError("503"), RuntimeError("503")])
    llm.set_client(fake)
    with pytest.raises(llm.LLMUnavailable):
        llm.structured("ops_route", OpsRoute, "sys", "q", tier="small")
    models = [c["model"] for c in fake.calls]
    assert models[0] == config.settings.model_small and models[-1] == config.settings.model_large
    assert ctx.fallbacks == 1


def test_budget_exceeded_short_circuits(llm_on, ctx):
    ctx.max_tokens = 10
    ctx.input_tokens = 11
    llm.set_client(FakeClient([]))
    with pytest.raises(llm.LLMUnavailable):
        llm.structured("x", OpsRoute, "s", "u")
