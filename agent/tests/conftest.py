import os
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
os.environ.setdefault("LLM_PROVIDER", "heuristic")
os.environ.setdefault("API_CALLBACK_URL", "")


@pytest.fixture()
def kb(tmp_path, monkeypatch):
    monkeypatch.setenv("CHECKPOINT_PATH", str(tmp_path / "ck.sqlite"))
    from app import config, indexer, services
    from app.graph import draft_graph

    config.reload_settings()
    services.use_memory_kb()
    services._db = None
    indexer.seed_static()
    draft_graph.set_graph(None)
    return services.get_kb()


@pytest.fixture()
def ctx():
    from app import runctx

    c = runctx.RunContext()
    tok = runctx.set_current(c)
    yield c
    runctx.reset(tok)
