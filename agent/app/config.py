"""Runtime configuration for the agent service (all values come from env vars)."""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = BASE_DIR / "data"


def _bool(name: str, default: bool) -> bool:
    v = os.getenv(name)
    if v is None:
        return default
    return v.strip().lower() in {"1", "true", "yes", "on"}


def _int(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, default))
    except ValueError:
        return default


def _float(name: str, default: float) -> float:
    try:
        return float(os.getenv(name, default))
    except ValueError:
        return default


@dataclass
class Settings:
    mongodb_uri: str = field(default_factory=lambda: os.getenv("MONGODB_URI", "mongodb://127.0.0.1:27017/jd-platform"))
    shared_secret: str = field(default_factory=lambda: os.getenv("AGENT_SHARED_SECRET", "dev-agent-secret-change-me"))
    callback_url: str = field(default_factory=lambda: os.getenv("API_CALLBACK_URL", "http://localhost:5000/api/internal/agent-callback"))

    # LLM
    llm_provider: str = field(default_factory=lambda: os.getenv("LLM_PROVIDER", "auto"))  # auto | anthropic | heuristic
    anthropic_api_key: str = field(default_factory=lambda: os.getenv("ANTHROPIC_API_KEY", ""))
    model_large: str = field(default_factory=lambda: os.getenv("MODEL_LARGE", "claude-sonnet-5-5"))
    model_small: str = field(default_factory=lambda: os.getenv("MODEL_SMALL", "claude-haiku-5-5"))
    llm_timeout_s: float = field(default_factory=lambda: _float("LLM_TIMEOUT_S", 45.0))
    llm_max_retries: int = field(default_factory=lambda: _int("LLM_MAX_RETRIES", 2))
    # USD per million tokens (input, output). Set these to your contract prices.
    price_large_in: float = field(default_factory=lambda: _float("PRICE_LARGE_IN", 3.0))
    price_large_out: float = field(default_factory=lambda: _float("PRICE_LARGE_OUT", 15.0))
    price_small_in: float = field(default_factory=lambda: _float("PRICE_SMALL_IN", 1.0))
    price_small_out: float = field(default_factory=lambda: _float("PRICE_SMALL_OUT", 5.0))

    # Embeddings
    embeddings_provider: str = field(default_factory=lambda: os.getenv("EMBEDDINGS_PROVIDER", "hashing"))
    voyage_api_key: str = field(default_factory=lambda: os.getenv("VOYAGE_API_KEY", ""))

    # Retrieval
    retrieval_mode: str = field(default_factory=lambda: os.getenv("RETRIEVAL_MODE", "hybrid"))  # hybrid | vector | bm25
    use_reranker: bool = field(default_factory=lambda: _bool("USE_RERANKER", True))
    retrieval_k: int = field(default_factory=lambda: _int("RETRIEVAL_K", 6))

    # Agent limits / budgets
    checkpoint_path: str = field(default_factory=lambda: os.getenv("CHECKPOINT_PATH", str(BASE_DIR / ".state" / "checkpoints.sqlite")))
    intake_max_turns: int = field(default_factory=lambda: _int("INTAKE_MAX_TURNS", 6))
    critic_max_iters: int = field(default_factory=lambda: _int("CRITIC_MAX_ITERS", 2))
    max_graph_steps: int = field(default_factory=lambda: _int("MAX_GRAPH_STEPS", 40))
    max_tool_calls: int = field(default_factory=lambda: _int("MAX_TOOL_CALLS", 8))
    max_tokens_per_run: int = field(default_factory=lambda: _int("MAX_TOKENS_PER_RUN", 60000))
    daily_token_budget_per_user: int = field(default_factory=lambda: _int("DAILY_TOKEN_BUDGET_PER_USER", 400000))
    confidence_threshold: float = field(default_factory=lambda: _float("CONFIDENCE_THRESHOLD", 0.6))
    pay_transparency_required: bool = field(default_factory=lambda: _bool("PAY_TRANSPARENCY_REQUIRED", True))
    critic_enabled: bool = field(default_factory=lambda: _bool("CRITIC_ENABLED", True))
    prompt_version: str = field(default_factory=lambda: os.getenv("PROMPT_VERSION", "v1.0"))

    @property
    def use_llm(self) -> bool:
        if self.llm_provider == "heuristic":
            return False
        if self.llm_provider == "anthropic":
            return True
        return bool(self.anthropic_api_key)


settings = Settings()


def reload_settings() -> Settings:
    """Re-read env (used by tests/evals that flip env vars)."""
    global settings
    new = Settings()
    settings.__dict__.update(new.__dict__)
    return settings
