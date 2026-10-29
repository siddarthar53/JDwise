# JDwise — agentic JD drafting & approval platform

> Role-based **Job Description** platform: an AI drafting agent (adaptive intake → retrieval-grounded generation → tools → critic loop → human-in-the-loop), a reviewer copilot, a revision agent for rejections, permission-aware Q&A, and an ops agent for HR — on top of a server-enforced approval pipeline (`draft → pending_manager → pending_hr → approved/rejected`).

**Principle:** AI proposes; humans and the state machine decide. No agent tool or endpoint can change a JD's approval status, every AI output is schema-validated twice (agent + API), and every AI layer is measured against the original rule-based flow (Baseline v0).

![Stack](https://img.shields.io/badge/React-18-61DAFB?logo=react&logoColor=white) ![Express](https://img.shields.io/badge/Express-4-000000?logo=express&logoColor=white) ![MongoDB](https://img.shields.io/badge/MongoDB-7-47A248?logo=mongodb&logoColor=white) ![FastAPI](https://img.shields.io/badge/FastAPI-0.11x-009688?logo=fastapi&logoColor=white) ![LangGraph](https://img.shields.io/badge/LangGraph-1.x-1C3C3C)

---

## Architecture

```text
React (Vite, TS) ──► Express API  (auth, JD CRUD, state machine, chat, notifications, analytics)   server/
                        │  HMAC-signed calls  ▲ signed callbacks (idempotent apply)
                        ▼                     │
              Agent service (Python · FastAPI · LangGraph)                                         agent/
                ├─ Intake agent (slot filling, asks only what's missing)
                ├─ Retrieval: hybrid BM25 + vectors → RRF → metadata-aware reranker, with citations
                ├─ Tools: find_similar_jds · get_org_context · get_salary_band · normalize_skills · check_duplicate_role
                ├─ Generator → schema validation/repair → Critic (rules + LLM) ⟲ revise (bounded)
                ├─ Confidence routing → human interrupt (checkpointed, resumable) → finalize
                ├─ Reviewer copilot · Revision agent · Q&A (permission-filtered) · Ops router · reminder drafts
                └─ Runs/traces, tokens, cost, budgets, fallbacks
                        │
          MongoDB: app data · agent_runs (traces) · kb_chunks (RAG index)  ·  SQLite: LangGraph checkpoints
```

**LLM provider.** With `ANTHROPIC_API_KEY` set the agents use Claude (small model for intake/critic/routing, large for generation/revision; forced-tool structured output; prompt caching; retries → repair → other model → deterministic fallback). Without a key every layer runs on a **deterministic implementation** of the same step, so the whole product — and the eval suite — works offline. If the agent service is down, the API falls back to the original 7-question flow.

### What each AI layer does (all implemented)

| Layer | Where | What it does |
|---|---|---|
| 1. Adaptive intake | `agent/app/agents/intake.py` | Extracts title, department, level, location, work mode, type, years, salary, skills, responsibilities from a brief, Slack message or pasted JD; per-field confidence; asks the single most useful next question; "same but Senior" directives; turn cap. |
| 2. RAG | `agent/app/rag/` | Section/bullet-aware chunks of approved JDs, a role library and the style guide; hybrid BM25 + embeddings with RRF and a level/department-aware reranker; every bullet records its source chunk. Approved JDs are indexed on approval. |
| 3. Generator + tools | `generator.py`, `tools.py` | Allow-listed, read-only tools with arg schemas, timeouts, retries, idempotency cache, per-run cap, parallel execution. |
| 4. Critic loop | `critic.py` | Deterministic rules (pay transparency, band compliance, inclusive language, level/years contradictions, impossible "N years of <tech>", vague/duplicate bullets, requirement stacks, duplicate roles) + optional LLM rubric; generate → critique → revise, max N iterations. |
| 5. HITL routing | `graph/draft_graph.py` | Low-confidence fields, band-suggested salary, unresolved errors, duplicates or tool failures pause the run (LangGraph interrupt) with precise questions; resumes days later from the checkpoint. |
| 6. Reviewer copilot | `reviewer.py` | Summary, changes since last submission, risks, suggested comments; reviewer still decides. Review-open/decision timestamps are recorded. |
| 7. Revision agent | `reviser.py` | Turns a rejection comment into a diff; author confirms before it's applied; content versioning (`versions[]`). |
| 8. Q&A | `qa.py` + `server/src/routes/assistant.ts` | API computes the user's visible JDs/conversations; retrieval is filtered before ranking; refuses when evidence is missing. |
| 9. Ops agent | `ops.py` + `server/src/analytics/queries.ts` | NL → one of 7 validated, parameterised queries (no free-form DB access); stuck-JD scan + drafted reminders HR confirms; scheduled daily digest. |
| 10. Memory | `server/src/utils/memory.ts` | Per-user tone and benefits; per-department skills humans repeatedly add to AI drafts are learned on approval. |

---

## Results (held-out test split, heuristic provider)

From `agent/evals/results/latest.md` — run `python -m evals.run_eval` to regenerate. Read the **honesty notes** in `agent/evals/README.md` first (synthetic cases; bugs were fixed during harness bring-up).

| Metric (n=38) | Baseline v0 | Agent |
|---|---|---|
| Questions asked per JD | 7 | 1.4 |
| Field accuracy | 58.3% | 98.7% |
| Rule-based rubric (1–5) | 3.56 | 4.91 |
| Compliance errors per JD | 1.63 | 0 |
| Planted flaws remaining (bias, level/years contradictions) | 100% | 0% |
| Injected instructions reaching the draft | 100% | 0% |
| Pay-transparency compliant | 86.8% | 100% |
| Bullets grounded in brief or a cited source | — | 100% |
| Escalation precision / recall | — | 100% / 96.9% |

Critic: 100% precision/recall on 120 seeded flaws, 0% false alarms on 20 clean JDs. Retrieval (21 labelled queries): hybrid + reranker recall@5 1.0, nDCG@5 0.95; removing the reranker drops recall@5 to 0.93 and nDCG to 0.90. Security: 0/5 permission-leak probes.

**What didn't work / open issues:** the escalation rate is ~80% because any band-suggested salary is confirmed with the author (safe, but chatty); vector-only retrieval matches hybrid on this small library, so the hybrid benefit is unproven at this scale; coverage is saturated because must-cover items come from the brief; LLM-mode numbers (cost, latency, judge calibration) need a real key and `--repeats 3`.

---

## User roles & demo accounts

Seeded by `npm run seed` in `server/` (also seeds approved history, a rejected-then-approved JD and a JD stuck at HR so analytics have data).

| Email | Password | Name | Role | Hierarchy |
|---|---|---|---|---|
| `hr@demo.com` | `Hr@123` | Sarah Johnson | `hr` | — |
| `manager@demo.com` | `Mgr@123` | Michael Chen | `employee` | Manages Alex, Jamie, Taylor |
| `employee@demo.com` | `Emp@123` | Alex Rivera | `employee` | Reports to Michael |
| `peer@demo.com` | `Peer@123` | Jamie Wilson | `employee` | Reports to Michael |
| `taylor@demo.com` | `Taylor@123` | Taylor Kim | `employee` | Reports to Michael |

**A 2-minute demo:** log in as Alex → *New JD* → paste "We need a senior backend engineer on the platform team in Bangalore. They will own our payments APIs, mentor juniors and improve reliability. Must know Go, Postgres and Kubernetes." → answer the one question → watch the live agent steps → confirm the salary band → open *Evidence* and *Quality* → submit. Log in as Michael → *Downline JD Approvals* → *Review* (copilot) → send back with "Should be staff level and remote". Back as Alex → *Let the assistant propose fixes* → apply → resubmit. As Sarah → *Ops Agent*, *AI Quality*, *Ask the Assistant*.

---

## Getting started

### Option A — Docker (everything)

```sh
cp agent/.env.example agent/.env      # optional: add ANTHROPIC_API_KEY
docker compose up --build
docker compose exec api npm run seed:prod
# web http://localhost:8080 · api http://localhost:5000 · agent http://localhost:8001/health
```

### Option B — local processes

Prerequisites: Node ≥ 18, Python ≥ 3.11, MongoDB (local or Atlas).

```sh
# 1. agent service
cd agent
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env            # set MONGODB_URI; ANTHROPIC_API_KEY or OPENROUTER_API_KEY optional
uvicorn app.main:app --port 8001 --env-file .env   # works in bash, cmd and PowerShell

# 2. API
cd server
cp .env.example .env            # MONGODB_URI, JWT_SECRET, AGENT_URL=http://localhost:8001, AGENT_SHARED_SECRET
npm install && npm run seed && npm run dev      # http://localhost:5000

# 3. web
cp .env.example .env            # VITE_API_URL=http://localhost:5000/api
npm install && npm run dev                       # http://localhost:8080
```

Leave `AGENT_URL` empty to run the app exactly as before (rule-based question flow only).

### Tests & evals

```sh
cd server && npm test                       # state machine, HMAC, proposal validation, analytics params
cd agent && python -m pytest -q tests       # intake, critic, guardrails, retrieval, tools, graph, LLM retry/repair/fallback
cd agent && python -m evals.run_eval --gate # golden-set eval with regression thresholds (what CI runs)
```

CI (`.github/workflows/ci.yml`) type-checks and builds the web app, runs API tests, runs agent tests and the eval gate, and uploads the eval report.

---

## Environment variables

**`server/.env`** — `MONGODB_URI`, `JWT_SECRET` (required in production), `PORT`, `CLIENT_ORIGIN`, `AGENT_URL` (empty = legacy flow only), `AGENT_SHARED_SECRET` (must match the agent), `OPS_SCAN_MINUTES` (default 60, 0 disables), `OPS_STUCK_HOURS` (default 48).

**`agent/.env`** — `MONGODB_URI`, `AGENT_SHARED_SECRET`, `API_CALLBACK_URL`, `LLM_PROVIDER` (`auto`/`anthropic`/`openrouter`/`heuristic`), `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY` (+ optional `OPENROUTER_BASE_URL`), `MODEL_LARGE`, `MODEL_SMALL`, `PRICE_*` (for cost tracking — set to your contract prices), `EMBEDDINGS_PROVIDER` (`hashing`/`voyage`/`openrouter`) + `VOYAGE_API_KEY` / `EMBEDDINGS_MODEL`, `RETRIEVAL_MODE`, `USE_RERANKER`, budgets (`MAX_TOKENS_PER_RUN`, `DAILY_TOKEN_BUDGET_PER_USER`, `MAX_TOOL_CALLS`, `CRITIC_MAX_ITERS`, `INTAKE_MAX_TURNS`), `CONFIDENCE_THRESHOLD`, `PAY_TRANSPARENCY_REQUIRED`, `PROMPT_VERSION`.

**`.env`** (web) — `VITE_API_URL`.

---

## API overview

All routes under `/api`; JWT required except auth and `/internal/*` (HMAC).

| Resource | Routes |
|---|---|
| Auth | `POST /auth/register`, `POST /auth/login`, `GET /auth/me` |
| Users | `GET /users`, `GET /users/subordinates`, `GET /users/:id` |
| JDs | `GET/POST /jds`, `GET/PATCH /jds/:id`, `GET /jds/:id/versions`, `POST /jds/:id/agent-message`, `GET /jds/:id/runs/:runId`, `DELETE /jds/:id/agent-thread`, `POST /jds/:id/critique`, `POST /jds/:id/submit`, `POST /jds/:id/approve`, `POST /jds/:id/reject`, `GET /jds/:id/copilot`, `POST /jds/:id/revise`, `POST /jds/:id/revise/apply`, `POST /jds/:id/mention`, `POST /jds/:id/peer-respond` |
| Assistant | `POST /assistant/ask` |
| Me | `GET/PUT /me/preferences` |
| Chat | `GET/POST /chat/conversations`, `GET/POST /chat/conversations/:id/messages` |
| Notifications | `GET /notifications`, `POST /notifications/:id/read`, `POST /notifications/read-all` |
| Admin (HR) | `GET /admin/overview`, `POST /admin/remind`, `GET /admin/analytics/catalog`, `POST /admin/analytics/run`, `POST /admin/ops/ask`, `GET /admin/ops/stuck`, `POST /admin/ops/send-reminders`, `GET /admin/metrics` |
| Internal | `POST /internal/agent-callback` (HMAC-signed by the agent) |

Agent service (internal only, HMAC): `POST /threads/:id/messages`, `GET /runs/:id`, `GET /threads/:id/state`, `DELETE /threads/:id`, `POST /critique`, `POST /review`, `POST /revise`, `POST /qa`, `POST /ops/route`, `POST /ops/reminders`, `POST /index/jd`, `POST /index/message`, `POST /index/sync`, `GET /metrics/summary`, `GET /runs`, `GET /health`.

---

## Reliability & safety

| Concern | Mechanism |
|---|---|
| Invalid output | Pydantic schemas + forced-tool structured output, one repair prompt, other-model retry, deterministic fallback; zod whitelist in the API (status/owner fields can never be written by AI). |
| Provider failure | Timeouts, exponential backoff, model fallback, deterministic agents, and the legacy flow if the agent service is unreachable. |
| Prompt injection | Untrusted text is wrapped as `<data>`; sentences containing instructions are dropped before extraction; tool allow-lists per node; no tool can write approvals. |
| PII | Emails, phones, IDs and secrets redacted before anything is written to traces; user ids are hashed. |
| Runaway cost/loops | Max graph steps, tool-call cap, per-run token budget, per-user daily budget (degrades to deterministic agents). |
| Duplicate actions | Idempotency keys on run creation; tool-result cache per run; run results applied once (`appliedRunIds`). |
| Authorization | State machine in `server/src/utils/stateMachine.ts`; Q&A retrieval filtered to ids the API authorises; every AI action is a recorded run, and applied revisions are attributed in `history`. |

---

## Project structure

```text
src/                                 React app
  components/workspace/JdConversation.tsx   agent chat, live steps, interrupts, editor, quality, evidence, versions, revision
  components/workspace/ApprovalsList.tsx    full JD view + reviewer copilot
  components/workspace/{AskPanel,OpsPanel,AiMetricsPanel}.tsx
  components/workspace/agent/*              Markdown, AgentProgress, QualityPanel, EvidencePanel, Copilot, Revision, Versions, Preferences, ResultChart
server/src/
  utils/stateMachine.ts aiApply.ts agentClient.ts memory.ts jdHelpers.ts textMetrics.ts opsScheduler.ts jdAgent.ts (Baseline v0)
  analytics/queries.ts metrics.ts
  routes/ jds assistant me admin internal chat auth users notifications
  models/ JobDescription (versions, aiRuns, aiMeta, reviewEvents) Preference Notification …
  tests/                              vitest
agent/
  app/ main.py runs.py config.py schemas.py llm.py tools.py guard.py security.py knowledge.py indexer.py
  app/agents/ intake generator critic reviewer reviser qa ops
  app/graph/draft_graph.py           LangGraph workflow
  app/rag/ embed bm25 store retriever
  data/                               skills taxonomy, salary bands, inclusive lexicon, role library, style guide
  evals/                              golden set builder, harness, thresholds, results
  tests/                              pytest
```

See `ARCHITECTURE.md` for the developer walkthrough.
