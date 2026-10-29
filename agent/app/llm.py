"""LLM access layer.

* Structured output only: every call forces a single tool whose input schema is
  the target Pydantic model, and the result is validated before it is returned.
* Reliability: per-call timeout, retries with exponential backoff, one repair
  prompt on validation failure, then fallback to the other model tier. If all
  of that fails the caller receives ``LLMUnavailable`` and uses the deterministic
  heuristic implementation of the same step (the final fallback).
* Model routing: ``tier="small"`` for intake/critic/routing, ``"large"`` for
  generation and revision.
* Prompt caching: the static system prefix is marked ``cache_control``.
* Providers: Anthropic (native SDK) or OpenRouter (``OpenRouterClient``
  adapter over its OpenAI-compatible API), selected by ``LLM_PROVIDER``.
"""
from __future__ import annotations

import copy
import json
import time
from types import SimpleNamespace
from typing import Literal, Optional, Type, TypeVar

from pydantic import BaseModel, ValidationError

from . import runctx
from .config import settings
from .guard import SYSTEM_SAFETY_RULES

T = TypeVar("T", bound=BaseModel)
Tier = Literal["small", "large"]


class LLMUnavailable(Exception):
    """Raised when no LLM result could be produced; caller must fall back."""


_client = None


class OpenRouterClient:
    """Adapter exposing ``messages.create`` (Anthropic-style kwargs and response
    shape) on top of OpenRouter's OpenAI-compatible chat completions API, so
    ``structured`` is provider-agnostic. Forced tool choice maps to a forced
    function call; usage maps to input/output/cache-read tokens."""

    def __init__(self, api_key: str, base_url: str, timeout: float):
        import httpx

        self._http = httpx.Client(
            base_url=base_url.rstrip("/"),
            timeout=timeout,
            headers={"Authorization": f"Bearer {api_key}", "X-Title": "JDFlow agent"},
        )
        self.messages = self

    def create(self, *, model, max_tokens, system, tools, tool_choice, messages):
        sys_text = "\n".join(b["text"] for b in system) if isinstance(system, list) else system
        body = {
            "model": model,
            "max_tokens": max_tokens,
            "messages": [{"role": "system", "content": sys_text}] + list(messages),
            "tools": [{"type": "function", "function": {"name": t["name"], "description": t["description"],
                                                         "parameters": t["input_schema"]}} for t in tools],
            "tool_choice": {"type": "function", "function": {"name": tool_choice["name"]}},
        }
        r = self._http.post("/chat/completions", json=body)
        r.raise_for_status()
        data = r.json()
        if data.get("error"):
            raise RuntimeError(f"openrouter: {data['error']}")
        msg = (data.get("choices") or [{}])[0].get("message") or {}
        content = []
        for tc in msg.get("tool_calls") or []:
            args = tc.get("function", {}).get("arguments")
            try:
                args = json.loads(args) if isinstance(args, str) else args
            except json.JSONDecodeError:
                pass  # left as a string; validation fails and triggers the repair prompt
            content.append(SimpleNamespace(type="tool_use", input=args))
        if not content and msg.get("content"):
            # some models answer with bare JSON instead of a tool call
            try:
                content.append(SimpleNamespace(type="tool_use", input=json.loads(msg["content"])))
            except json.JSONDecodeError:
                pass
        u = data.get("usage") or {}
        usage = SimpleNamespace(
            input_tokens=u.get("prompt_tokens", 0),
            output_tokens=u.get("completion_tokens", 0),
            cache_read_input_tokens=(u.get("prompt_tokens_details") or {}).get("cached_tokens", 0),
        )
        return SimpleNamespace(content=content, usage=usage)


def _get_client():
    global _client
    if _client is None:
        if settings.llm_backend == "openrouter":
            _client = OpenRouterClient(settings.openrouter_api_key, settings.openrouter_base_url, settings.llm_timeout_s)
        else:
            import anthropic  # imported lazily so heuristic mode has no hard dependency

            _client = anthropic.Anthropic(api_key=settings.anthropic_api_key, timeout=settings.llm_timeout_s, max_retries=0)
    return _client


def set_client(client) -> None:
    """Test hook: inject a fake client."""
    global _client
    _client = client


def _inline_refs(schema: dict) -> dict:
    """Pydantic emits $defs/$ref; inline them so the tool schema is self-contained."""
    schema = copy.deepcopy(schema)
    defs = schema.pop("$defs", {})

    def walk(node):
        if isinstance(node, dict):
            if "$ref" in node:
                name = node["$ref"].split("/")[-1]
                return walk(copy.deepcopy(defs[name]))
            return {k: walk(v) for k, v in node.items()}
        if isinstance(node, list):
            return [walk(x) for x in node]
        return node

    return walk(schema)


def _price(model: str, tin: int, tout: int) -> float:
    if model == settings.model_small:
        return tin / 1e6 * settings.price_small_in + tout / 1e6 * settings.price_small_out
    return tin / 1e6 * settings.price_large_in + tout / 1e6 * settings.price_large_out


def structured(
    task: str,
    schema: Type[T],
    system: str,
    user: str,
    tier: Tier = "large",
    max_tokens: int = 2000,
) -> T:
    if not settings.use_llm:
        raise LLMUnavailable("LLM disabled (heuristic mode)")

    ctx = runctx.current()
    if ctx.llm_disabled:
        raise LLMUnavailable("LLM disabled for this run (daily budget reached)")
    try:
        ctx.check_budget()
    except runctx.BudgetExceeded as e:
        ctx.event("budget", str(e))
        raise LLMUnavailable(str(e)) from e

    primary = settings.model_small if tier == "small" else settings.model_large
    secondary = settings.model_large if tier == "small" else settings.model_small
    tool_name = f"emit_{schema.__name__.lower()}"
    tool = {
        "name": tool_name,
        "description": f"Return the {task} result. Must match the schema exactly.",
        "input_schema": _inline_refs(schema.model_json_schema()),
    }
    system_blocks = [
        {"type": "text", "text": SYSTEM_SAFETY_RULES + "\n" + system, "cache_control": {"type": "ephemeral"}},
    ]
    messages: list[dict] = [{"role": "user", "content": user}]
    first_attempt = True

    for model in (primary, secondary):
        repair_used = False
        msgs = list(messages)
        attempt = 0
        while attempt <= settings.llm_max_retries:
            attempt += 1
            t0 = time.time()
            try:
                resp = _get_client().messages.create(
                    model=model,
                    max_tokens=max_tokens,
                    system=system_blocks,
                    tools=[tool],
                    tool_choice={"type": "tool", "name": tool_name},
                    messages=msgs,
                )
            except Exception as e:  # network, rate-limit, 5xx, timeout
                ctx.record_llm(task=task, model=model, input_tokens=0, output_tokens=0, cache_read=0, cost=0.0,
                               latency_ms=(time.time() - t0) * 1000, ok=False, error=str(e), attempt=attempt)
                ctx.retries += 1
                time.sleep(min(8.0, 0.5 * (2 ** (attempt - 1))))
                continue

            usage = getattr(resp, "usage", None)
            tin = int(getattr(usage, "input_tokens", 0) or 0)
            tout = int(getattr(usage, "output_tokens", 0) or 0)
            cread = int(getattr(usage, "cache_read_input_tokens", 0) or 0)
            payload = None
            for block in getattr(resp, "content", []) or []:
                if getattr(block, "type", "") == "tool_use":
                    payload = block.input
                    break
            try:
                if payload is None:
                    raise ValueError("model returned no tool_use block")
                result = schema.model_validate(payload)
                ctx.record_llm(task=task, model=model, input_tokens=tin, output_tokens=tout, cache_read=cread,
                               cost=_price(model, tin, tout), latency_ms=(time.time() - t0) * 1000, ok=True, attempt=attempt)
                if first_attempt and task == "generate":
                    ctx.first_pass_valid = True
                return result
            except (ValidationError, ValueError) as e:
                ctx.validation_errors += 1
                if first_attempt and task == "generate":
                    ctx.first_pass_valid = False
                first_attempt = False
                ctx.record_llm(task=task, model=model, input_tokens=tin, output_tokens=tout, cache_read=cread,
                               cost=_price(model, tin, tout), latency_ms=(time.time() - t0) * 1000, ok=False,
                               error=f"validation: {e}", attempt=attempt)
                if repair_used:
                    break  # one repair per model, then try the other tier
                repair_used = True
                msgs = msgs + [
                    {"role": "assistant", "content": f"(previous output) {json.dumps(payload)[:4000] if payload else ''}"},
                    {"role": "user", "content": f"Your output failed validation:\n{str(e)[:1500]}\nReturn a corrected result by calling {tool_name}."},
                ]
        ctx.event("llm", f"{task}: falling back from {model}")
    ctx.fallbacks += 1
    raise LLMUnavailable(f"{task}: all LLM attempts failed")
