# Rolewrite (JD Platform)

> A role-based **Job Description (JD) management** app for HR teams and employees — AI-assisted JD drafting, multi-level approval workflows (manager → HR), peer mentions, real chat, and an HR company-wide dashboard. Backed by a **Node/Express + MongoDB** API.

![Stack](https://img.shields.io/badge/React-18-61DAFB?logo=react&logoColor=white)
![Vite](https://img.shields.io/badge/Vite-5-646CFF?logo=vite&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white)
![Express](https://img.shields.io/badge/Express-4-000000?logo=express&logoColor=white)
![MongoDB](https://img.shields.io/badge/MongoDB-8-47A248?logo=mongodb&logoColor=white)
![Tailwind](https://img.shields.io/badge/Tailwind-3-38B2AC?logo=tailwind-css&logoColor=white)

---

## Table of Contents

1. [Architecture](#architecture)
2. [User Roles & Demo Accounts](#user-roles--demo-accounts)
3. [Getting Started](#getting-started)
4. [Environment Variables](#environment-variables)
5. [Deployment](#deployment)
6. [API Overview](#api-overview)
7. [Design System](#design-system)
8. [Project Structure](#project-structure)
9. [Notes & Limitations](#notes--limitations)

---

## Architecture

```text
jd-convo/
├── src/                # React + Vite frontend
│   ├── lib/api.ts       # fetch wrapper (adds JWT, base URL)
│   ├── context/AuthContext.tsx   # real login/register/me against the API
│   ├── hooks/useJDs.ts, useWorkspace.ts   # react-query hooks for every resource
│   ├── types/index.ts   # shared frontend types
│   └── components/workspace/     # AppShell, JdConversation, ApprovalsList,
│                                  # ChatPanel, AdminOverview, PipelineStepper
└── server/              # Express + MongoDB API
    └── src/
        ├── models/       # User, JobDescription, Conversation, Message, Notification
        ├── routes/       # auth, users, jds, chat, notifications, admin
        ├── middleware/auth.ts     # JWT verification
        └── utils/jdAgent.ts       # rule-based JD question flow (+ optional LLM polish)
```

The frontend talks to the API over plain `fetch` (`VITE_API_URL`, default `http://localhost:5000/api`) with a JWT stored in `localStorage` and sent as `Authorization: Bearer <token>`.

### JD approval pipeline

Every JD moves through: `draft → pending_manager → pending_hr → approved` (or `rejected` at either approval stage). If an employee has no manager, it skips straight to `pending_hr`. This is enforced server-side in `server/src/routes/jds.ts`, not just in the UI.

---

## User Roles & Demo Accounts

Seeded by `npm run seed` inside `/server` (see below).

| Email               | Password    | Name          | Role       | Hierarchy           |
| ------------------- | ----------- | ------------- | ---------- | -------------------- |
| `hr@demo.com`       | `Hr@123`    | Sarah Johnson | `hr`       | —                     |
| `manager@demo.com`  | `Mgr@123`   | Michael Chen  | `employee` | Manages Alex, Jamie, Taylor |
| `employee@demo.com` | `Emp@123`   | Alex Rivera   | `employee` | Reports to Michael    |
| `peer@demo.com`     | `Peer@123`  | Jamie Wilson  | `employee` | Reports to Michael    |
| `taylor@demo.com`   | `Taylor@123`| Taylor Kim    | `employee` | Reports to Michael    |

A user is treated as a **manager** purely when someone else's `reportsTo` points at them — no separate role needed.

---

## Getting Started

### Prerequisites

- **Node.js** ≥ 18
- **MongoDB** — either a local instance (`mongod` running on `27017`) or a free [MongoDB Atlas](https://www.mongodb.com/atlas) cluster.

### 1. Backend

```sh
cd server
cp .env.example .env
# edit .env: set MONGODB_URI to your local or Atlas connection string

npm install
npm run seed     # wipes & re-seeds demo users + a sample JD
npm run dev       # starts the API on http://localhost:5000
```

### 2. Frontend

```sh
# from the repo root
cp .env.example .env
# VITE_API_URL defaults to http://localhost:5000/api — only edit if your API runs elsewhere

npm install
npm run dev        # http://localhost:8080
```

Log in with any demo account above (or use "Sign up" to create a new one).

### Production build

```sh
# frontend
npm run build && npm run preview

# backend
cd server && npm run build && npm start
```

---

## Environment Variables

**`server/.env`**

| Variable            | Required | Notes                                                        |
| ------------------- | -------- | -------------------------------------------------------------|
| `MONGODB_URI`        | yes      | Local or Atlas connection string.                            |
| `JWT_SECRET`         | yes (required when `NODE_ENV=production`) | Long random string; used to sign session tokens. The server refuses to start in production without it. |
| `PORT`                | no       | Defaults to `5000`.                                          |
| `CLIENT_ORIGIN`       | no       | Comma-separated allowed CORS origins. Defaults to `http://localhost:8080`. |
| `ANTHROPIC_API_KEY`   | no       | If set, JD summaries are additionally polished via the real Anthropic API. |

**`.env` (repo root, frontend)**

| Variable        | Required | Notes                                   |
| ---------------- | -------- | ---------------------------------------|
| `VITE_API_URL`    | no       | Defaults to `http://localhost:5000/api`.|

---

## Deployment

The frontend and API deploy independently; both are standard Node projects with no hosting-provider dependency.

- **Frontend** — static SPA. Build with `npm run build` and serve the `dist/` directory from any static host. Set `VITE_API_URL` at **build time** to the public API URL, and configure the host to rewrite all unknown paths to `index.html` (client-side routing).
- **API** — build with `npm run build` and run `npm start` inside `server/`. Set `NODE_ENV=production`, `MONGODB_URI`, `JWT_SECRET`, and `CLIENT_ORIGIN` (the deployed frontend origin, for CORS).

---

## API Overview

All routes are namespaced under `/api` and (except `/auth/register` and `/auth/login`) require `Authorization: Bearer <token>`.

| Resource      | Routes |
| ------------- | ------ |
| Auth          | `POST /auth/register`, `POST /auth/login`, `GET /auth/me` |
| Users         | `GET /users`, `GET /users/subordinates`, `GET /users/:id` |
| Job descriptions | `GET/POST /jds`, `GET/PATCH /jds/:id`, `POST /jds/:id/agent-message`, `POST /jds/:id/submit`, `POST /jds/:id/approve`, `POST /jds/:id/reject`, `POST /jds/:id/mention`, `POST /jds/:id/peer-respond` |
| Chat          | `GET/POST /chat/conversations`, `GET/POST /chat/conversations/:id/messages` |
| Notifications | `GET /notifications`, `POST /notifications/:id/read`, `POST /notifications/read-all` |
| Admin (HR only) | `GET /admin/overview`, `POST /admin/remind` |

---

## Design System

New palette (`src/index.css`), all HSL tokens consumed through Tailwind:

- **Signal Indigo** `#4338CA` — primary actions, links, active nav state.
- **Ink** `#14152B` — sidebar / hero background.
- **Emerald** `#10B981` — approved / success.
- **Amber** `#F59E0B` — pending / warning.
- **Rose** `#E11D48` — rejected / destructive.
- **Paper** `#F7F7FB` — light-mode background.

Type: **Space Grotesk** for headings/display, **Inter** for body copy, **JetBrains Mono** for status labels, timestamps, and IDs.

**Signature element:** the JD **pipeline stepper** (`src/components/workspace/PipelineStepper.tsx`) — a small horizontal stage tracker (Draft → Manager → HR → Approved) reused on every JD card, the conversation panel, and approval lists, so the JD's position in its lifecycle is always visible at a glance.

Dark mode is a full token set (not just inverted grays) and toggles from the header sun/moon icon.

---

## Project Structure

```text
src/
├── App.tsx, main.tsx
├── index.css                      # design tokens + component classes
├── lib/api.ts                     # fetch client
├── types/index.ts
├── context/AuthContext.tsx
├── hooks/
│   ├── useJDs.ts                  # JD CRUD, agent messages, approvals, mentions
│   └── useWorkspace.ts            # users, notifications, chat, admin overview
├── components/
│   ├── Login.tsx                  # split-screen sign in / sign up
│   ├── ProtectedRoute.tsx
│   ├── ui/                        # shadcn primitives
│   └── workspace/
│       ├── AppShell.tsx           # sidebar + topbar + notifications + dark mode
│       ├── PipelineStepper.tsx    # signature stage tracker
│       ├── StatusBadge.tsx
│       ├── JdConversation.tsx     # AI agent chat + draft editor + mentions + submit
│       ├── ApprovalsList.tsx      # shared by HR review, manager downline, peer approvals
│       ├── ChatPanel.tsx          # real conversations + messages
│       └── AdminOverview.tsx      # HR stats + employee table + reminders
└── pages/Dashboard.tsx            # role-based nav + view switch

server/src/
├── index.ts                       # Express app entry
├── db.ts                          # Mongoose connection
├── seed.ts                        # demo data
├── models/                        # User, JobDescription, Conversation, Message, Notification
├── middleware/auth.ts             # JWT verification
├── routes/                        # auth, users, jds, chat, notifications, admin
└── utils/jdAgent.ts, notify.ts, jwt.ts
```

---

## Notes & Limitations

- The **AI Agent** is a deterministic question flow by default (title → department → summary → responsibilities → qualifications → skills → salary/type) so the app works with zero external API keys. Set `ANTHROPIC_API_KEY` in `server/.env` to additionally polish the generated summary through the real Anthropic API.
- Chat is polling-based (refetch every ~10–15s), not WebSocket — simplest reliable option without adding infrastructure. Swapping in Socket.io or MongoDB change streams later is a drop-in change to `useWorkspace.ts` / `server/src/routes/chat.ts`.
- Passwords are hashed with bcrypt; sessions are stateless JWTs (7-day expiry) — there's no refresh-token rotation yet.
- Employee sign-up defaults new managers to no direct reports; wire `reportsTo` via the `/auth/register` `reportsTo` field or update it directly in MongoDB if you need deeper org charts than the seed data.
