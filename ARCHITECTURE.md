# JDwise (JD Platform) — Developer Onboarding Guide

This document is for a new developer joining the project. It complements the
`README.md` (which covers setup/run commands) by explaining **how the app
actually works end to end**: the data model, the request/response flow, the
JD approval pipeline, how the AI agent conversation works, how peer mentions
and chat/notifications tie together, and where to look in the code for each
piece.

If you only read one section, read **"The JD lifecycle, end to end"** — that
workflow is the spine the whole app is built around.

---

## 1. High-level shape of the system

```
┌────────────────────────┐        HTTPS/JSON, fetch()        ┌───────────────────────────┐
│  Frontend (src/)         │ ───────────────────────────────▶ │  Backend (server/src/)      │
│  React 18 + Vite + TS    │ ◀─────────────────────────────── │  Express 4 + Mongoose 8     │
│  react-query, Tailwind   │        JWT in Authorization      │  JWT auth, bcrypt hashing   │
└────────────────────────┘                header             └─────────────┬─────────────┘
                                                                              │
                                                                              ▼
                                                                    ┌──────────────────┐
                                                                    │     MongoDB        │
                                                                    │  users, jds,        │
                                                                    │  conversations,      │
                                                                    │  messages,           │
                                                                    │  notifications       │
                                                                    └──────────────────┘
```

- The **frontend** is a single-page app. There is no server-side rendering.
  It never talks to MongoDB directly — everything goes through the Express
  API in `server/`.
- The **backend** is a fairly classic REST API: one Express router file per
  resource (`auth`, `users`, `jds`, `chat`, `notifications`, `admin`), each
  mounted under `/api/<resource>` in `server/src/index.ts`.
- There is **no WebSocket / real-time layer**. "Live" features (chat,
  notifications) are done by polling with react-query's `refetchInterval`.
  See section 6.

---

## 2. Core domain concept: the Job Description (JD)

Everything in this app orbits one document type: the **Job Description**
(`server/src/models/JobDescription.ts`). A JD is not just a static document —
it's a stateful object that moves through a workflow and accumulates a
conversation, a history log, and peer sign-offs as it goes.

Key fields on a JD:

| Field | Purpose |
|---|---|
| `status` | Where the JD is in the approval pipeline (see section 3). |
| `conversation[]` | The back-and-forth with the AI agent that built the draft (role: `assistant`/`user`, content, timestamp). |
| `conversationStep` | Which question the agent is currently on (an index into a fixed question list). |
| `title`, `department`, `employmentType`, `summary`, `responsibilities[]`, `qualifications[]`, `skills[]`, `salaryRange` | The actual JD content — filled in as the conversation progresses, and editable afterwards. |
| `history[]` | An audit trail: every submit/approve/reject action, who did it, when, and any comment. |
| `peerApprovals[]` | People the author has @-mentioned for `approval`, `feedback`, or `collaboration`, each with their own pending/approved/rejected status. |
| `createdBy` | The employee who owns this JD. |

A JD is always owned by exactly one employee (`createdBy`). Only the owner
can edit its content, run the agent conversation, mention peers, or submit
it. Managers/HR act on it only through the approval endpoints.

---

## 3. The JD lifecycle, end to end

This is the workflow every new developer should internalize first.

```
 draft ──submit──▶ pending_manager ──approve──▶ pending_hr ──approve──▶ approved
   │                     │                           │
   │                     └──reject──▶ rejected ◀─────┘
   └── (no manager) ─────────────────────────────────▶ pending_hr directly
```

1. **`draft`** — An employee starts a new JD (`POST /api/jds`). This creates
   a `JobDescription` with `status: 'draft'` and seeds `conversation` with
   the AI agent's opening question. The employee answers questions one at a
   time (`POST /api/jds/:id/agent-message`); each answer patches a field on
   the JD (see section 4). At any point the employee can also hand-edit any
   field directly with `PATCH /api/jds/:id`.

2. **Submit** — `POST /api/jds/:id/submit`. This is the one place the
   pipeline branches, and the branch is decided **server-side**, not in the
   UI (`server/src/routes/jds.ts`):
   - If the author's `reportsTo` is set → status becomes `pending_manager`,
     and a notification is sent to that manager.
   - If the author has **no manager** (e.g. HR staff, or a manager with no
     manager of their own) → status skips straight to `pending_hr`, and all
     HR users are notified.

3. **`pending_manager`** — Only the specific user referenced by the author's
   `reportsTo` field is authorized to approve/reject at this stage
   (enforced in the route handler, not just hidden in the UI). Approving
   moves the JD to `pending_hr` and notifies all HR users. Rejecting sets
   `status: 'rejected'` and notifies the author with the manager's comment.

4. **`pending_hr`** — Only users with `role: 'hr'` can act here. Approving
   sets `status: 'approved'` (a terminal state) and notifies the author.
   Rejecting sets `status: 'rejected'` and notifies the author.

5. **`approved` / `rejected`** — `approved` is terminal. A `rejected` JD is editable again by its owner and can be **resubmitted** (`history` records `resubmitted`); the author can ask the revision agent to turn the reviewer's comment into a proposed diff first.

All transitions go through `server/src/utils/stateMachine.ts` (`transition(action, ctx)`), which is unit-tested in `server/tests/stateMachine.test.ts`. Route handlers never assign `status` directly, and `submit` now rejects JDs that are already in review or approved.

**Where "manager" comes from:** there is no separate "manager" role. Any user
whose `_id` appears as someone else's `reportsTo` is treated as a manager for
that person. `role` on `User` is only ever `'hr'` or `'employee'`. This is
why `Dashboard.tsx` computes `isManager = !!subordinates?.length` on the
frontend (from `GET /api/users/subordinates`) rather than checking a role
field — it's a derived property, not stored data.

Every transition appends an entry to `history[]` (`action`, `byUser`,
optional `comment`, timestamp) — this is what powers any "audit trail" /
timeline UI and is the closest thing the app has to activity logging.

---

## 4. The AI drafting agent

Drafting is done by the Python **agent service** (`agent/`), a FastAPI app running a LangGraph workflow per JD (thread id = JD id). The Express API stays the source of truth.

**Request flow.** `POST /api/jds/:id/agent-message` saves the user turn, then calls the agent (`POST /threads/:jdId/messages`, HMAC-signed, idempotency key = JD id + turn index) with context: current JD fields, org context and the author's preferences. The agent returns a `run_id` immediately; the JD gets `agentState: 'running'` and `activeRunId`. The UI polls `GET /api/jds/:id/runs/:runId`, which shows the run's live step events. When the run settles the agent POSTs a signed callback to `/api/internal/agent-callback`; `utils/aiApply.ts` validates the proposal with zod (content fields only), applies it once (`appliedRunIds`), snapshots a `versions[]` entry and sets `agentState` to `collecting` (it asked a question), `needs_input` (human gate) or `ready`. The poll endpoint applies too, as a backstop.

**The graph** (`agent/app/graph/draft_graph.py`): `intake → (ask_user ⟲) → retrieve → plan_tools → generate → validate → critic ⟲ revise → route → (human_gate → apply_answer → retrieve …) → finalize`. Interrupts are persisted in a SQLite checkpointer, so a run paused for the author's answer resumes whenever they reply. A message after `finalize` is treated as a refinement ("make it senior").

**Fallbacks.** No `ANTHROPIC_API_KEY` → every node uses its deterministic implementation. Agent service unreachable or `AGENT_URL` empty → the API uses the original 7-question script in `utils/jdAgent.ts` (`agentState: 'legacy'`), which is also Baseline v0 in the evals.

**Where this shows up in the UI:** `JdConversation.tsx` (chat with live steps, review questions, editor with confidence hints, quality panel, evidence/citations, version history, revision dialog).

## 5. Roles, permissions, and who can see what

There are exactly two stored roles (`User.role`): `'hr'` and `'employee'`.
"Manager" is a derived relationship (see section 3). All authorization is
enforced **in the Express route handlers**, using the JWT payload
(`req.userId`, `req.userRole`) attached by `requireAuth` /
`requireRole('hr')` in `server/src/middleware/auth.ts`. Treat the frontend's
hiding of buttons/tabs as UX only — never as the security boundary.

Practical scoping rules to know:

- **`GET /api/jds`** — HR sees every JD in the system. A regular employee
  sees only: JDs they created, JDs created by their direct subordinates, and
  any JD where they appear in `peerApprovals`. This is computed with a Mongo
  `$or` filter in `routes/jds.ts`.
- **Editing a JD** (`PATCH`, agent messages, submit, mentions) is restricted
  to `createdBy === req.userId`.
- **Approving/rejecting** is restricted per-stage: the specific manager at
  `pending_manager`, any HR user at `pending_hr`.
- **`GET /api/admin/overview`** and **`POST /api/admin/remind`** require
  `role: 'hr'` via `requireRole('hr')`.

---

## 6. Peer mentions, chat, and notifications — how users communicate

There are two distinct communication mechanisms in this app; don't conflate
them.

### 6a. Peer mentions (JD-scoped, workflow-integrated)

A JD author can tag any other users on their *own* JD for `approval`,
`feedback`, or `collaboration` (`POST /api/jds/:id/mention`). This:

- Appends an entry per user to `peerApprovals[]` on that JD (deduplicated —
  already-mentioned users are skipped).
- Sends each mentioned user a `mention`-type notification.

The mentioned peer later responds with `POST /api/jds/:id/peer-respond`
(`status: 'approved' | 'rejected'`, optional `comment`), which updates their
own entry in `peerApprovals[]` and notifies the JD's author. This is
**separate from the manager/HR approval pipeline** in section 3 — a JD can
be fully "approved" by every mentioned peer while still sitting in
`pending_hr`, and vice versa. Peer approvals are advisory/collaborative
context, not a gate on `status`.

`src/components/workspace/ApprovalsList.tsx` is shared UI used for three
different views (HR's queue, a manager's downline queue, and a user's peer
mentions) — same component, different data source/props.

### 6b. Direct chat (freeform, not JD-scoped)

A completely separate system: `Conversation` + `Message` models
(`server/src/models/Conversation.ts`, `Message.ts`). Any user can start a 1:1
or group conversation with any other user (`POST /api/chat/conversations`);
for 1:1 chats the backend reuses an existing conversation between the same
two participants instead of creating duplicates. Messages are plain
`POST /api/chat/conversations/:id/messages`, and every *other* participant
gets a `message`-type notification with a preview of the content.

`src/components/workspace/ChatPanel.tsx` renders this. It is **polling**,
not sockets — `useMessages()` and `useConversations()` in
`src/hooks/useWorkspace.ts` use react-query's `refetchInterval` (10s for
messages, 15s for conversation list). If you need true real-time later, the
README notes this is a drop-in swap to Socket.io or Mongo change streams in
those two hook functions plus the corresponding routes — the rest of the app
doesn't need to change.

### 6c. Notifications (the glue)

`server/src/utils/notify.ts` is a tiny helper (`notify({ user, type, title,
message, jd? })`) that every other route calls to create a `Notification`
document. It's fire-and-forget — nothing else depends on its return value.
Notification `type` values (`jd_submitted`, `jd_approved`, `jd_rejected`,
`mention`, `message`, `info`) drive icon/styling in the UI but don't affect
behavior. The frontend polls `GET /api/notifications` every 20s
(`useNotifications()` in `useWorkspace.ts`) and shows an unread badge count;
`POST /api/notifications/:id/read` and `/read-all` mark things read.

**Rule of thumb:** if you add any new state-changing action to the JD or
chat routes and someone besides the actor should know about it, call
`notify(...)` in that same route handler — that's the established pattern
everywhere in `server/src/routes/`.

---

## 7. Frontend structure and data flow

- **Auth**: `src/context/AuthContext.tsx` holds the current `user` and
  exposes `login`/`register`/`logout`. The JWT itself lives in
  `localStorage` under `jd-platform-token` (`src/lib/api.ts`), not in
  React state — `AuthContext` re-hydrates the user by calling `GET /auth/me`
  on mount if a token exists.
- **API client**: `src/lib/api.ts` is a thin `fetch` wrapper (`api.get/post/
  patch/delete`) that automatically attaches `Authorization: Bearer <token>`
  and throws a typed `ApiError` (with `.status`) on non-2xx responses.
- **Data fetching**: everything else goes through TanStack Query.
  `src/hooks/useJDs.ts` covers all JD operations (list, single, create,
  agent-message, update, submit, approve, reject, mention, peer-respond).
  `src/hooks/useWorkspace.ts` covers users/directory, notifications, chat,
  and the HR admin overview. Mutations invalidate the relevant query keys on
  success (e.g. approving a JD invalidates `['jds']`, `['notifications']`,
  and `['admin-overview']`) — that's how the UI stays in sync without
  sockets.
- **Routing**: `src/App.tsx` — just `/login`, `/dashboard` (behind
  `ProtectedRoute`), `/unauthorized`, and a catch-all 404. There's no
  per-feature routing; instead...
- **`src/pages/Dashboard.tsx`** does role-based *tab switching* inside a
  single route. It builds a different `navItems` list for `hr` vs
  `employee` (and adds a "Downline JD Approvals" tab for employees who
  happen to be managers, i.e. have subordinates), and swaps which
  `workspace/` component renders based on `activeTab` state — there's no
  URL per tab.
- **Shared workspace components** (`src/components/workspace/`):
  `AppShell` (sidebar/topbar/notifications/dark-mode chrome),
  `PipelineStepper` (the Draft→Manager→HR→Approved visual, reused
  everywhere a JD's status needs to be shown), `StatusBadge`,
  `JdConversation` (agent chat + draft editor + mention/submit actions),
  `ApprovalsList` (reused for HR/manager/peer approval queues),
  `ChatPanel`, `AdminOverview` (HR-only company-wide table + reminders).

---

## 8. Backend structure at a glance

```
server/src/
├── index.ts        # Express app: CORS, JSON body parsing, morgan logging,
│                    #   mounts each router under /api/<resource>, connects DB, listens
├── db.ts            # Mongoose connection helper
├── seed.ts          # wipes & recreates demo users + one sample JD (npm run seed)
├── models/           # Mongoose schemas — see section 2 & 6 for JobDescription/Conversation/Message/Notification; User holds auth + org-chart (reportsTo)
├── middleware/auth.ts  # requireAuth (verifies JWT, sets req.userId/userRole), requireRole(...roles)
├── routes/
│   ├── auth.ts        # register/login/me — bcrypt hashing, JWT issuance
│   ├── users.ts        # directory list, subordinates, single user (for @mentions, chat, manager views)
│   ├── jds.ts          # the whole JD lifecycle — see sections 3 & 4
│   ├── chat.ts         # conversations + messages
│   ├── notifications.ts
│   └── admin.ts        # HR-only company overview + bulk reminders
└── utils/
    ├── jdAgent.ts       # the deterministic question flow (section 4)
    ├── notify.ts        # thin Notification.create() wrapper
    └── jwt.ts           # sign/verify helpers
```

Auth model: **stateless JWT**, 7-day expiry, no refresh tokens, no
server-side session store. `Authorization: Bearer <token>` on every
protected request. Passwords are bcrypt-hashed (`passwordHash` on `User`,
never returned by any endpoint — see `publicUser()` helpers in `auth.ts` /
`users.ts` that strip it before responding).

---

## 9. Things a new developer should know before changing anything

- **Status transitions are enforced server-side** in `utils/stateMachine.ts`.
  If you add a status or approval stage, change it there and in its tests.
- **Peer approvals never gate the manager/HR pipeline.** Don't assume a JD
  needs all `peerApprovals` resolved before it can move to `approved` —
  currently it doesn't.
- **No real-time transport.** Anything that feels "live" (chat, notification
  badge, approval queues updating for other users) is polling +
  react-query cache invalidation. If two people are in the room, they will
  see each other's changes with up to ~10–20s of lag, not instantly.
- **AI never writes status.** Agent output reaches Mongo only through
  `utils/aiApply.ts` (zod whitelist). Keep it that way: add new AI-written
  fields to `ProposalFields`, never bypass it.
- **"Manager" is derived, not stored.** Don't add a `manager` enum value to
  `User.role` — the whole app keys off `reportsTo` pointing at you.
- **`.env.example`** exists at both repo root (frontend, just `VITE_API_URL`)
  and in `server/` (`MONGODB_URI`, `JWT_SECRET`, `PORT`, `CLIENT_ORIGIN`,
  optional `ANTHROPIC_API_KEY`) — copy both to `.env` before running.
- **Seeding**: `npm run seed` inside `server/` wipes and recreates the demo
  accounts in the README table plus one sample JD — the fastest way to get a
  manager/employee/HR chain to test the approval pipeline locally.

---

## 10. Quick map: "I want to change X, where do I look?"

| You want to... | Look at |
|---|---|
| Add a new JD status / pipeline stage | `server/src/models/JobDescription.ts` (enum), `server/src/routes/jds.ts` (`/submit`, `/approve`, `/reject`), `src/components/workspace/PipelineStepper.tsx`, `src/types/index.ts` |
| Change the agent's questions | `server/src/utils/jdAgent.ts` (`STEPS`, `processAnswer`) |
| Add a new notification trigger | Call `notify(...)` from `server/src/utils/notify.ts` inside the relevant route; add the `type` to `Notification.ts`'s enum if it's new |
| Add real-time updates | `src/hooks/useWorkspace.ts` (`useMessages`, `useConversations`) + `server/src/routes/chat.ts` — swap polling for sockets/change streams here first |
| Change who can approve at a given stage | `server/src/routes/jds.ts` `/approve` and `/reject` handlers |
| Change the org chart / manager assignment | `User.reportsTo` field; set via `/auth/register`'s `reportsTo` or directly in MongoDB |
| Change visual design tokens | `src/index.css` (HSL tokens), `tailwind.config.ts` |
| Add a new HR-only admin capability | `server/src/routes/admin.ts` (guard with `requireRole('hr')`), `src/components/workspace/AdminOverview.tsx`, `src/hooks/useWorkspace.ts` |

---

## 11. Related docs

- `README.md` — setup, environment variables, demo accounts, run commands.

---

## 12. The agentic layer at a glance

| Concern | Code |
|---|---|
| LLM access (structured output, retries, repair, model fallback, prompt caching, cost) | `agent/app/llm.py` |
| Per-run tracing, budgets, token/cost accounting | `agent/app/runctx.py`, `agent/app/runs.py` (`agent_runs` collection) |
| Prompt-injection & PII guards | `agent/app/guard.py` |
| Tools (allow-list, schemas, timeouts, idempotency) | `agent/app/tools.py` |
| RAG index & retrieval | `agent/app/rag/*`, `agent/app/indexer.py` (`kb_chunks` collection) |
| Agents | `agent/app/agents/{intake,generator,critic,reviewer,reviser,qa,ops}.py` |
| Company data (bands, taxonomy, lexicon, role library, style guide) | `agent/data/` |
| Analytics query layer (ops agent executes only these) | `server/src/analytics/queries.ts` |
| Business metrics (AI vs legacy cohorts) | `server/src/analytics/metrics.ts` |
| Memory | `server/src/utils/memory.ts`, `models/Preference.ts` |
| Evals & CI gate | `agent/evals/`, `.github/workflows/ci.yml` |

**Adding an agent capability:** write the deterministic version first (so it works offline and has a baseline), add the LLM version behind `llm.structured(...)` with a Pydantic schema, record it as a run (`runs.run_sync`), add tests, then add an eval metric before claiming it helps.
