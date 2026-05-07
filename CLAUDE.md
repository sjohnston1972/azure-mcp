# CLAUDE.md — azure-mcp

> **Project name:** `azure-mcp`
> **Working directory:** `C:\docker\net-core\azure-mcp`
> **Public URL:** `https://azure-mcp.clydeford.net`
> **Owner:** Steven Johnston

---

## 1. What this project is

`azure-mcp` is a **single-user web tool** that lets the operator design and deploy any combination of Azure resources through a hybrid GUI:

- A **chat panel** powered by Claude (Anthropic API), which drives the work.
- A **topology canvas** that auto-lays-out the architecture as it's built or imported.
- The **Azure MCP Server** (Microsoft's official `.mcpb` / containerised build — see https://devblogs.microsoft.com/azure-sdk/azure-mcp-server-mcpb-support/) as the execution layer that actually talks to Azure.

The user describes what they want, Claude proposes an architecture, the canvas renders it, and the user either reviews a generated Bicep template before deploying *or* fires the deployment live via MCP tool calls — their choice, per deployment.

Every deployment is **tagged** with a project name, so resources stay grouped and differentiable inside the Azure subscription. The tool maintains its own persistent record of named projects, saved templates, and deployment history.

---

## 2. Critical context for Claude Code

Read this section carefully before doing anything else.

### 2.1 The user is not a coder

Steven is a senior network/cloud architect, not a software engineer. He understands systems, infrastructure, and architecture deeply, but he does not write code himself and does not necessarily understand how a codebase should be laid out. When you write code:

- **Comment generously**, especially in non-obvious places. Explain *why*, not just *what*.
- **Keep the directory structure flat and obvious.** No clever monorepo tooling, no abstract `core/domain/infrastructure` layering. A backend folder, a frontend folder, a docker folder. That's it.
- **Name files for what they do**, not for design patterns. `azure-deploy.ts` not `DeploymentOrchestratorFactory.ts`.
- **When you make non-obvious decisions, document them in `DECISIONS.md`** at the repo root, in plain English. This file is for Steven, not for you.
- **Treat the README as a teaching document.** Assume Steven will come back to this in six months having forgotten how it works.

### 2.2 Visual style reference

There is an existing project at `C:\docker\net-core\netbud\frontend` whose visual style this tool should match. **Read that directory before designing any UI.** Specifically:

- Pull out the colour palette, typography, spacing, and component shapes.
- Match the overall vibe — dark/light mode, density, corner radii, button styles.
- Do **not** clone components verbatim; produce equivalent ones in this codebase, but the *aesthetic* should feel like the same family of tool.
- Document what you found in `DECISIONS.md` under a "Visual style inheritance" heading so Steven can verify.

### 2.3 Deployment target

This project lives on Steven's homelab in the existing `net-core` Docker network, which already has a Cloudflare tunnel attached. Public access is at `azure-mcp.clydeford.net`.

- **Auth at the edge:** Cloudflare Access in front of the tunnel. The application itself trusts the `Cf-Access-Authenticated-User-Email` header.
- **No internal auth system to build.** Single-user tool, edge-authenticated. Don't build a login screen.
- **All secrets via `.env`.** A `.env.example` must be committed; the real `.env` must be in `.gitignore`.

---

## 3. Architecture

### 3.1 High-level diagram (in words)

```
[User browser]
     │  (HTTPS via Cloudflare tunnel + Access)
     ▼
[Cloudflare Edge] ── azure-mcp.clydeford.net
     │
     ▼
[net-core Docker network on homelab]
   │
   ├── azure-mcp-frontend   (React + Vite, served by nginx or similar)
   │
   ├── azure-mcp-backend    (Node.js / TypeScript API + orchestrator)
   │       │
   │       ├── talks to ──► Anthropic API (Claude)
   │       └── talks to ──► azure-mcp-server (over MCP stdio or HTTP)
   │
   ├── azure-mcp-server     (Microsoft's Azure MCP Server, containerised)
   │       │
   │       └── talks to ──► Azure Resource Manager (using SP from .env)
   │
   └── azure-mcp-db         (Postgres — projects, templates, history)
```

### 3.2 Why each piece exists

- **Frontend** is a React SPA. It owns the chat panel, the topology canvas (React Flow + auto-layout), the project switcher, deployment history view, and template library.
- **Backend** is the brain. It does NOT call Azure directly. Its jobs are:
  1. Receive chat messages from the frontend.
  2. Forward them to Claude via the Anthropic Messages API, with the Azure MCP Server registered as a tool source.
  3. Stream Claude's responses (and tool calls / tool results) back to the frontend.
  4. Persist projects, templates, and deployment history to Postgres.
  5. Translate canvas state into prompts and back.
- **Azure MCP Server** is Microsoft's official server. It exposes 100+ Azure tools. We do not reimplement these. Run it as a sidecar container.
- **Postgres** holds projects, templates, and history. Lightweight schema — see §6.

### 3.3 What lives where on disk

```
C:\docker\net-core\azure-mcp\
├── docker-compose.yml         # orchestrates all four containers on net-core network
├── .env.example               # template — committed
├── .env                       # real secrets — gitignored
├── .gitignore
├── README.md                  # teaching-style: how to run, how to extend
├── DECISIONS.md               # plain-English log of architectural choices
├── CLAUDE.md                  # this file (kept up to date)
│
├── frontend\                  # React + Vite + TypeScript
│   ├── src\
│   │   ├── components\        # canvas, chat panel, project picker, etc.
│   │   ├── hooks\
│   │   ├── lib\               # api client, types
│   │   └── styles\            # matches netbud visual style
│   ├── public\
│   ├── package.json
│   └── Dockerfile
│
├── backend\                   # Node.js + TypeScript + Express (or Fastify)
│   ├── src\
│   │   ├── routes\            # /api/chat, /api/projects, /api/templates, /api/deploy
│   │   ├── claude\            # Anthropic API client + MCP tool wiring
│   │   ├── mcp\               # connection to azure-mcp-server
│   │   ├── db\                # postgres client + migrations
│   │   └── server.ts
│   ├── package.json
│   └── Dockerfile
│
├── mcp-server\                # thin wrapper around Microsoft's image
│   └── Dockerfile             # if a wrapper is needed; otherwise reference the official image directly in compose
│
└── db\
    └── init.sql               # initial schema
```

---

## 4. The user experience (what the GUI does)

### 4.1 Layout

A three-pane layout, MATE-style:

```
┌─────────────────────────────────────────────────────────────┐
│  Header: project switcher | "Deploy" button | settings      │
├──────────────────────┬──────────────────────────────────────┤
│                      │                                      │
│   Topology canvas    │     Chat panel                       │
│   (React Flow)       │     (Claude conversation)            │
│                      │                                      │
│   - auto-laid-out    │     - streams Claude responses       │
│   - shows tool calls │     - shows tool calls inline        │
│     as they happen   │     - "Review Bicep" / "Deploy now"  │
│                      │       buttons appear in context      │
│                      │                                      │
└──────────────────────┴──────────────────────────────────────┘
```

A collapsible **left rail** holds: Projects list, Saved templates, Deployment history.

### 4.2 Topology canvas behaviour

- Use **React Flow** (`@xyflow/react`).
- Auto-layout via **dagre** or **ELK** — pick whichever you can ship faster. Document the choice in `DECISIONS.md`.
- Each node = one Azure resource. Node visuals should follow the netbud style and use Azure resource icons (the official Microsoft Azure icon set is fine — link to it from a CDN, don't bundle).
- Edges = relationships (e.g. VNet → subnet, App Service → SQL DB).
- The canvas is **read-mostly in v1**. The user does not drag-and-drop to design. They describe what they want in chat; Claude proposes; the canvas updates. The user may *delete* a node from the canvas (which removes it from the proposed plan) but composition is chat-driven.
- When a deployment is running, nodes show a status: pending → deploying → success / failed. Tool call results from MCP populate this in real time.

### 4.3 Chat panel behaviour

- Each user message goes to the backend, which calls Claude with the conversation history and the Azure MCP Server registered as available tools.
- Claude's tool calls and results render inline in the chat (collapsible).
- When Claude proposes a deployment, two action buttons appear:
  - **Review Bicep** — Claude generates a Bicep template via the MCP server's template generation tool, shown in a side drawer with syntax highlighting. User clicks "Deploy this" to proceed.
  - **Deploy live** — Claude executes the deployment directly via MCP tool calls. Results stream back as they happen.
- The user picks per deployment. Default the button order based on which mode the user used last.

### 4.4 Project & tagging model

- Every project has a name (e.g. `vigil-lab`, `gladius-test`).
- All resources deployed under that project receive Azure tags:
  - `azure-mcp-project = <project-name>`
  - `azure-mcp-deployment-id = <deployment-uuid>`
  - `azure-mcp-deployed-at = <ISO timestamp>`
- The canvas, when a project is selected, queries Azure (via MCP) for resources carrying that project tag and shows them.
- This is how the tool "remembers" what it deployed even though Cloudflare/edge auth is stateless. Source of truth is *Azure itself*, augmented by our local Postgres history.

### 4.5 Deployment history & saved templates

- **History** = an append-only log in Postgres: deployment id, project, timestamp, mode (Bicep-reviewed vs live), the prompt that triggered it, the resulting Bicep (if applicable), the MCP tool call sequence, success/failure.
- **Saved templates** = user-named Bicep snippets the user explicitly saves from a previous deployment. "Save as template" button on any reviewed deployment.
- Templates can be loaded into a new project as the starting point ("Build me a new lab from the `vigil-baseline` template").

---

## 5. Azure connectivity

### 5.1 Authentication

- **Service principal**, full subscription access, credentials in `.env`:
  ```
  AZURE_TENANT_ID=
  AZURE_CLIENT_ID=
  AZURE_CLIENT_SECRET=
  AZURE_SUBSCRIPTION_ID=
  ```
- The `azure-mcp-server` container picks these up via standard Azure SDK env-var auth. No `az login` required.
- **Note for Steven:** Full subscription access is the simplest setup but means this tool can create or destroy *anything* in the subscription. If you want to scope this down later, the path is: create a new SP with Contributor only on a specific resource group (e.g. `azure-mcp-sandbox`), and update `.env`. No code changes needed.

### 5.2 Resource scope for v1

The tool must support deploying these categories from day one:

- **Compute** — VMs, App Service, Container Apps, AKS
- **Networking** — VNets, subnets, NSGs, Public IPs, Load Balancers, Azure Firewall
- **Storage & databases** — Storage accounts, Azure SQL, Cosmos DB
- **Identity & security** — Key Vault, Managed Identities, RBAC role assignments
- **AI/ML** — Azure AI Foundry, Azure OpenAI, Cognitive Services

The Azure MCP Server already covers all of these — the work is on the frontend (icons, node types, canvas representation), not on the backend.

### 5.3 Existing-resource visibility

In v1, the canvas shows resources tagged with the current project's `azure-mcp-project` tag. **It does not show or import arbitrary existing resources** that were deployed by hand or by other tools — that's deliberately out of scope to keep v1 finishable.

A "Refresh from Azure" button on the canvas re-queries by tag and updates node statuses.

---

## 6. Database schema (Postgres)

Keep this minimal. Three tables:

```sql
CREATE TABLE projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT UNIQUE NOT NULL,
  description TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE deployments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
  mode TEXT NOT NULL,           -- 'bicep-reviewed' or 'live-mcp'
  prompt TEXT NOT NULL,         -- what the user asked for
  bicep TEXT,                   -- the generated template, if any
  tool_calls JSONB,             -- the MCP tool call sequence
  status TEXT NOT NULL,         -- 'pending' | 'success' | 'failed' | 'partial'
  error TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT UNIQUE NOT NULL,
  description TEXT,
  bicep TEXT NOT NULL,
  source_deployment_id UUID REFERENCES deployments(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

That's the whole schema. Add migrations using a lightweight tool (`node-pg-migrate` is fine). **Do not add an ORM.** Raw SQL with parameterised queries is easier for Steven to read.

---

## 7. Environment variables (`.env.example`)

```bash
# ─── Anthropic ──────────────────────────────────────────────
ANTHROPIC_API_KEY=

# Model to use for the chat orchestration. Default to Claude Opus 4.7 (the
# most capable model) for architecture work; Sonnet is fine for tighter loops.
ANTHROPIC_MODEL=claude-opus-4-7

# ─── Azure (service principal) ──────────────────────────────
AZURE_TENANT_ID=
AZURE_CLIENT_ID=
AZURE_CLIENT_SECRET=
AZURE_SUBSCRIPTION_ID=

# ─── Postgres ───────────────────────────────────────────────
POSTGRES_HOST=azure-mcp-db
POSTGRES_PORT=5432
POSTGRES_DB=azuremcp
POSTGRES_USER=azuremcp
POSTGRES_PASSWORD=

# ─── App ────────────────────────────────────────────────────
PUBLIC_URL=https://azure-mcp.clydeford.net
TRUSTED_USER_EMAIL=        # the email Cloudflare Access will assert; backend rejects anything else
PORT_BACKEND=3000
PORT_FRONTEND=8080
```

The backend should validate every required var on startup and exit loudly if any are missing. **Don't fail silently.**

---

## 8. Docker Compose

A single `docker-compose.yml` at the repo root, attached to the existing external `net-core` network. Reference it as:

```yaml
networks:
  net-core:
    external: true
```

Four services: `frontend`, `backend`, `mcp-server`, `db`. Only `frontend` needs to be reachable via the Cloudflare tunnel — the rest are internal-only on `net-core`.

Use named volumes for the Postgres data and any MCP server cache. Healthchecks on backend and db.

---

## 9. Build order (what to do first)

Do not try to build the whole thing in one pass. Build it in this order, and **stop after each step to confirm it works** before moving on. Use `DECISIONS.md` to log what you found and chose along the way.

1. **Read the visual style reference** at `C:\docker\net-core\netbud\frontend`. Document the palette, typography, and component patterns in `DECISIONS.md`.
2. **Stand up the empty skeleton** — `docker-compose.yml`, four containers, `.env.example`, hello-world frontend and backend, Postgres with the schema applied. Confirm everything starts and the frontend is reachable through the tunnel.
3. **Wire the Azure MCP Server container** and confirm the backend can list it as a tool source. A simple endpoint that returns the available MCP tools is a good smoke test.
4. **Wire Claude** — the backend's `/api/chat` endpoint that streams a Claude response with the MCP server registered as tools. Test with "list my Azure resource groups". If that returns a real list from Azure, the backbone is working.
5. **Build the chat UI** matching the netbud style. Get a clean conversational loop working before touching the canvas.
6. **Build the topology canvas** — start with React Flow and a hardcoded set of nodes so the visual is right, *then* wire it to the backend so Claude's tool calls populate it.
7. **Add projects, tagging, and the project switcher.** This is where the tool starts to feel like itself.
8. **Add the dual-mode deployment flow** (Bicep review drawer + live deploy).
9. **Add deployment history and saved templates.**
10. **Polish, README, and DECISIONS.md final pass.**

---

## 10. What to ask before guessing

Where this spec is silent or ambiguous, ask Steven directly rather than assuming. Specific places where this is likely to come up:

- Exact node visuals on the canvas (icon set version, label positioning, status indicator style).
- Whether to use a session/cookie or a header for the Cloudflare Access identity check.
- Which auto-layout library to commit to.
- How verbose the inline tool-call rendering in the chat should be (collapsed by default? expanded?).

When in doubt, choose the simpler option, ship it, and note it in `DECISIONS.md` with a "revisit if Steven dislikes" tag.

---

## 11. What this project is NOT

- **Not multi-tenant.** Single user. Don't build user management.
- **Not a Cloudflare Worker.** Earlier draft of this spec called for that; it was wrong because the MCP server can't run inside a Worker. Frontend, backend, MCP server, and DB all live on the homelab inside the `net-core` Docker network, fronted by the existing Cloudflare tunnel.
- **Not a general-purpose Bicep IDE.** The Bicep review step is a sanity check before deployment, not an editor. Show it, syntax-highlight it, deploy it. Don't build a full editor in v1.
- **Not a state-reconciliation tool like Terraform.** The tool deploys; Azure is the source of truth; tags are how we find what we deployed. We do not maintain a local copy of "desired state" and reconcile.
- **Not for production multi-environment workloads.** This is a Sword-internal demo and personal lab tool. Keep that in mind when choices come up between "robust" and "simple" — pick simple.
