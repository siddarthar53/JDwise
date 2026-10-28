"""Per-run context: tracing, token/cost accounting, budgets. Accessed through a
ContextVar so graph nodes, tools and the LLM layer can record into the active run
without threading it through every call."""
from __future__ import annotations

import contextvars
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Optional

from .guard import redact


class BudgetExceeded(Exception):
    pass


@dataclass
class RunContext:
    run_id: str = field(default_factory=lambda: uuid.uuid4().hex)
    kind: str = "draft"
    user_hash: str = ""
    jd_id: str = ""
    started: float = field(default_factory=time.time)
    events: list[dict] = field(default_factory=list)
    llm_calls: list[dict] = field(default_factory=list)
    tool_calls: list[dict] = field(default_factory=list)
    input_tokens: int = 0
    output_tokens: int = 0
    cache_read_tokens: int = 0
    cost_usd: float = 0.0
    fallbacks: int = 0
    retries: int = 0
    validation_errors: int = 0
    first_pass_valid: Optional[bool] = None
    steps: int = 0
    max_tokens: int = 60000
    max_tool_calls: int = 8
    llm_disabled: bool = False

    # ---- events -------------------------------------------------------
    def event(self, step: str, message: str, **data: Any) -> None:
        self.events.append({
            "step": step,
            "message": redact(message)[:500],
            "at": time.time(),
            "data": {k: v for k, v in data.items() if v is not None},
        })

    # ---- accounting ---------------------------------------------------
    def check_budget(self) -> None:
        if self.input_tokens + self.output_tokens > self.max_tokens:
            raise BudgetExceeded(f"run token budget {self.max_tokens} exceeded")

    def record_llm(self, *, task: str, model: str, input_tokens: int, output_tokens: int, cache_read: int,
                   cost: float, latency_ms: float, ok: bool, error: str = "", attempt: int = 1) -> None:
        self.input_tokens += input_tokens
        self.output_tokens += output_tokens
        self.cache_read_tokens += cache_read
        self.cost_usd += cost
        self.llm_calls.append({"task": task, "model": model, "in": input_tokens, "out": output_tokens,
                               "cache_read": cache_read, "cost": round(cost, 6), "latency_ms": round(latency_ms, 1),
                               "ok": ok, "error": redact(error)[:300], "attempt": attempt})

    def record_tool(self, *, tool: str, args: dict, ok: bool, latency_ms: float, error: str = "", cached: bool = False) -> None:
        self.tool_calls.append({"tool": tool, "args": {k: (redact(str(v))[:200]) for k, v in args.items()},
                                "ok": ok, "latency_ms": round(latency_ms, 1), "error": redact(error)[:300], "cached": cached})

    def summary(self) -> dict:
        return {
            "input_tokens": self.input_tokens,
            "output_tokens": self.output_tokens,
            "cache_read_tokens": self.cache_read_tokens,
            "cost_usd": round(self.cost_usd, 6),
            "llm_calls": len(self.llm_calls),
            "tool_calls": len(self.tool_calls),
            "tool_errors": sum(1 for t in self.tool_calls if not t["ok"]),
            "fallbacks": self.fallbacks,
            "retries": self.retries,
            "validation_errors": self.validation_errors,
            "first_pass_valid": self.first_pass_valid,
            "steps": self.steps,
            "latency_ms": round((time.time() - self.started) * 1000, 1),
        }


_current: contextvars.ContextVar[Optional[RunContext]] = contextvars.ContextVar("run_ctx", default=None)


def current() -> RunContext:
    ctx = _current.get()
    if ctx is None:
        ctx = RunContext(kind="adhoc")
        _current.set(ctx)
    return ctx


def set_current(ctx: Optional[RunContext]):
    return _current.set(ctx)


def reset(token) -> None:
    _current.reset(token)
