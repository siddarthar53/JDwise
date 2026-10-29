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


class FakeHTTP:
    def __init__(self, payloads):
        self.payloads = list(payloads)
        self.posts = []

    def post(self, path, json):
        self.posts.append((path, json))
        data = self.payloads.pop(0)
        return SimpleNamespace(raise_for_status=lambda: None, json=lambda: data)


def _or_resp(message):
    return {"choices": [{"message": message}],
            "usage": {"prompt_tokens": 120, "completion_tokens": 30, "prompt_tokens_details": {"cached_tokens": 40}}}


def test_openrouter_adapter_maps_tool_call(llm_on, ctx):
    client = llm.OpenRouterClient("k", "https://example.test/api/v1", 5)
    client._http = FakeHTTP([_or_resp({"tool_calls": [{"function": {"name": "emit_opsroute",
                                                                     "arguments": '{"query_id": "status_counts"}'}}]})])
    llm.set_client(client)
    r = llm.structured("ops_route", OpsRoute, "sys", "q", tier="small")
    assert r.query_id == "status_counts"
    path, body = client._http.posts[0]
    assert path == "/chat/completions"
    assert body["messages"][0]["role"] == "system" and "sys" in body["messages"][0]["content"]
    assert body["tool_choice"] == {"type": "function", "function": {"name": "emit_opsroute"}}
    assert body["tools"][0]["function"]["parameters"]["type"] == "object"
    assert ctx.input_tokens == 120 and ctx.cache_read_tokens == 40


def test_openrouter_adapter_bad_json_triggers_repair(llm_on, ctx):
    client = llm.OpenRouterClient("k", "https://example.test/api/v1", 5)
    client._http = FakeHTTP([
        _or_resp({"tool_calls": [{"function": {"name": "emit_opsroute", "arguments": "{not json"}}]}),
        _or_resp({"content": '{"query_id": "throughput"}'}),  # bare-JSON answer is accepted too
    ])
    llm.set_client(client)
    r = llm.structured("ops_route", OpsRoute, "sys", "q")
    assert r.query_id == "throughput" and ctx.validation_errors == 1


def test_auto_provider_resolution(monkeypatch):
    monkeypatch.setenv("LLM_PROVIDER", "auto")
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.setenv("OPENROUTER_API_KEY", "sk-or-test")
    assert config.reload_settings().llm_backend == "openrouter"
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-test")
    assert config.reload_settings().llm_backend == "anthropic"
    monkeypatch.setenv("LLM_PROVIDER", "heuristic")
    config.reload_settings()
