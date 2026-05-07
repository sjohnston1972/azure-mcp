# DECISIONS.md — azure-mcp

> Plain-English log of architectural choices made while building this tool.
> Written for Steven (a senior network/cloud architect, not a coder).
> If something here looks wrong, push back — these are starting points,
> not gospel.

---

## 1. Azure service principal (READ FIRST — you need to do this)

The MCP server talks to Azure using a **service principal** (an app-style
identity with API credentials). Your `.env` has four blank `AZURE_*`
variables and the backend will refuse to start until they're filled in.

### Mint a service principal

Run these in PowerShell or any shell with the Azure CLI logged in to the
subscription you want the tool to manage:

```powershell
# 1. Confirm you're in the right subscription
az account show --query "{subscription:name, id:id, tenant:tenantId}"

# 2. Mint a Contributor SP scoped to the whole subscription
#    (you can scope down to a single resource group later — see "Scoping
#    down" below)
$SUB_ID = az account show --query id -o tsv
az ad sp create-for-rbac `
  --name "azure-mcp-homelab" `
  --role Contributor `
  --scopes "/subscriptions/$SUB_ID"
```

The output looks like this — copy each value into `.env`:

```json
{
  "appId":         "<-- AZURE_CLIENT_ID",
  "displayName":   "azure-mcp-homelab",
  "password":      "<-- AZURE_CLIENT_SECRET",
  "tenant":        "<-- AZURE_TENANT_ID"
}
```

`AZURE_SUBSCRIPTION_ID` is the `id` you printed in step 1.

### Scoping down (do this later if you want to be cautious)

Full subscription Contributor means this tool can create or destroy *any*
resource in the subscription. If you want a sandbox, replace step 2 with:

```powershell
az group create --name azure-mcp-sandbox --location uksouth
$RG_ID = az group show --name azure-mcp-sandbox --query id -o tsv
az ad sp create-for-rbac `
  --name "azure-mcp-homelab" `
  --role Contributor `
  --scopes "$RG_ID"
```

Now the SP can only touch resources inside `azure-mcp-sandbox`. No code
changes needed; just rotate `.env` and restart compose.

### Rotating the secret

`az ad sp credential reset --id <appId>` mints a new password. Update
`AZURE_CLIENT_SECRET` and restart.

---

## 2. Visual style inheritance (from `netbud/frontend`)

The new tool must feel like part of the same family as netbud. Here's
what I took from netbud and what I'm reusing.

### Stack

| Decision | Choice | Why |
|---|---|---|
| CSS framework | **Tailwind CSS 4** with `@theme` block in CSS | Matches netbud exactly. v4 is config-in-CSS — no `tailwind.config.js` to maintain. |
| Font | **Inter** (Google Fonts, weights 300–800) | Netbud's body font. |
| Icon set (UI chrome) | **Material Symbols Outlined** (Google Fonts CDN) | Netbud uses these. Free, CDN-loaded, no bundle weight. |
| Icon set (Azure resources) | **Microsoft official Azure icons** (CDN, not bundled) | Per CLAUDE.md §4.2. |
| Theme | **Light mode only** | Netbud is light-only; no dark variant defined. |

### Colour palette (lifted verbatim from `netbud/frontend/src/index.css`)

These are the MD3 tokens I'm writing into our `index.css`:

| Token | Hex | Used for |
|---|---|---|
| `--color-primary` | `#0059bb` | Brand blue, primary buttons, focus rings |
| `--color-primary-container` | `#0070ea` | Lighter blue for gradient end-stop |
| `--color-on-primary` | `#ffffff` | Text/icons on primary |
| `--color-secondary` | `#006c4f` | Success / verified / "deployed OK" |
| `--color-tertiary` | `#585c61` | Neutral content |
| `--color-error` | `#ba1a1a` | Errors / failed deploys |
| `--color-surface` | `#f8f9fa` | App background |
| `--color-surface-container-lowest` | `#ffffff` | Cards / modals |
| `--color-surface-container-low` | `#f3f4f5` | Subtle panels, input backgrounds |
| `--color-surface-container` | `#edeeef` | Mid-tone container |
| `--color-surface-container-high` | `#e7e8e9` | Hover state for surface-container |
| `--color-surface-container-highest` | `#e1e3e4` | Darkest container |
| `--color-on-surface` | `#191c1d` | Primary text |
| `--color-on-surface-variant` | `#414754` | Secondary / muted text |
| `--color-outline` | `#717786` | Mid-weight dividers |
| `--color-outline-variant` | `#c1c6d7` | Light dividers, subtle borders |

### Layout

- **Top nav**: 64px (`h-16`), sticky, z-40.
- **Left rail (collapsible)**: 256px expanded (`w-64`), 64px collapsed (`w-16`). Holds Projects / Templates / History.
- **Main area** for azure-mcp is the **two-pane workspace** from CLAUDE.md §4.1: topology canvas left, chat panel right.
- **Resize handle** between the two panes uses netbud's pattern: 6px wide vertical pill, `bg-outline-variant/40` → `bg-primary/60` on drag.

### Component shapes

- Cards: `rounded-xl` (12px), `shadow-sm`, header `px-6 py-4`, body `px-6 py-5`.
- Buttons:
  - Primary: gradient `bg-gradient-to-br from-primary to-primary-container`, white text.
  - Secondary: `border border-outline-variant/40`, `hover:bg-surface-container-high`.
  - Ghost: no background, `text-on-surface-variant hover:text-on-surface`.
- Inputs / textareas: `p-2.5 rounded-lg bg-surface-container-low border border-outline-variant/40 focus:ring-2 focus:ring-primary/30`.
- Status chips: `px-2.5 py-1 rounded-full text-[11px] font-bold`, 10% bg tint + full-colour text.
- Modals: `bg-on-surface/40 backdrop-blur-sm` overlay, `shadow-2xl` dialog.

### Topology canvas background

Reusing netbud's "workbench grid" — radial-gradient dots at 32px spacing
(`#c1c6d7` 1px). Identical to their DesignCompose canvas. This makes the
two tools feel like siblings the moment you open them.

### What I deliberately did NOT copy

- **Cytoscape**: netbud uses Cytoscape + cytoscape-dagre for topology.
  We're using **React Flow + dagre** because CLAUDE.md mandated React Flow
  and the canvas interactions (status pulses, side-drawer reveal) are
  simpler with React Flow's component model. Same auto-layout engine.
- **No login screen**: netbud has none either; both rely on Cloudflare
  Access at the edge.

---

## 3. Stack choices (foundation)

| Layer | Choice | Why |
|---|---|---|
| Frontend | React 19 + Vite + Tailwind 4 + TypeScript | Matches netbud (netbud is JSX, but we add TypeScript because the MCP tool-call schemas are heavily typed). |
| Frontend serving | nginx (multi-stage Dockerfile) | Matches netbud's pattern. nginx proxies `/api/*` to backend on `net_core`. |
| Backend | Node 22 + Fastify + TypeScript | Fastify has first-class streaming and is lighter than Express. Native SSE support. |
| MCP SDK | `@modelcontextprotocol/sdk` (official) | Not reimplementing the protocol. |
| Anthropic SDK | `@anthropic-ai/sdk` (official) | Same. |
| DB | Postgres 16, raw `pg` driver, `node-pg-migrate` for migrations | CLAUDE.md §6 says no ORM. Raw SQL with parameterised queries. |
| Auto-layout (canvas) | **dagre** (`@dagrejs/dagre`) | Faster to ship than ELK. Layouts are good enough for v1; revisit if they get cramped. |
| Container orchestration | docker compose, four services on `net_core` external network | Matches netbud and the wider homelab. |

---

## 4. Network & hostname plumbing

- **Actual docker network name is `net_core`** (underscore), not
  `net-core` (hyphen) as written in CLAUDE.md §3.1. CLAUDE.md is the
  spec; the network already existed before this project. We attach to
  `net_core` and document the discrepancy here. (CLAUDE.md updated to
  match.)
- **No host port publishing.** Cloudflare tunnel reaches
  `azure-mcp-frontend:80` directly on `net_core` — same pattern netbud
  uses. To wire `azure-mcp.clydeford.net` to the container you need to
  add a Public Hostname in the Cloudflare Zero Trust dashboard:
  - Subdomain: `azure-mcp`
  - Domain: `clydeford.net`
  - Service: `http://azure-mcp-frontend:80`
- **Cloudflare Access** policy in front of the public hostname asserts
  the user's identity in the `Cf-Access-Authenticated-User-Email`
  header. Backend rejects anything that doesn't match `TRUSTED_USER_EMAIL`
  in `.env`.

For local-only development (no tunnel), copy
`docker-compose.override.yml.example` → `docker-compose.override.yml` to
publish ports to localhost. (Override file added at the polish step.)

---

## 5. Azure MCP transport — stdio, not HTTP (revisit when the upstream beta stabilises)

CLAUDE.md §3.2 said "Run [the Azure MCP Server] as a sidecar container."
We tried that with `--transport=http` (the streamable-HTTP successor to
SSE) and hit two blockers in Microsoft's `3.0.0-beta.9` image:

1. The `--dangerously-disable-http-incoming-auth` flag silently aborts
   the process with exit code 1 — no log output even with `--debug` and
   trace logging. Confirmed reproducible.
2. With auth enabled (the default), the server advertises an OAuth
   Protected Resource Metadata document pointing at
   `https://login.microsoftonline.com//v2.0` (note the empty tenant
   path between the two slashes). Implementing the OAuth client flow
   against a malformed authorization URL is a non-starter.

So we pivoted to **stdio transport**, which is what Microsoft's official
docs primarily document anyway. New shape:

- The `azure-mcp` sidecar service is removed from `docker-compose.yml`.
- The backend container has the host's Docker socket mounted at
  `/var/run/docker.sock`, and `docker-cli` is installed inside the
  backend image.
- `backend/src/mcp/client.ts` uses `StdioClientTransport` to spawn
  `docker run -i --rm ... mcr.microsoft.com/azure-sdk/azure-mcp:latest
  --transport=stdio` as a child process at first use, and reuses that
  connection for every subsequent call.
- The spawned MCP container exits when the backend closes (we wire a
  `SIGTERM`/`SIGINT` handler to call `client.close()` so we don't leak
  orphaned `azure-mcp-stdio-*` containers between restarts).

**Trade-off (acceptable for a single-user homelab tool):** the backend
has Docker socket access, which is effectively root on the host. We're
fine with this because (a) the only ingress to the backend is through
Cloudflare Access on `azure-mcp.clydeford.net`, and (b) we control the
backend container's image end-to-end. A multi-tenant or production
deployment of this tool would need to switch back to HTTP transport
once the upstream beta stabilises.

Revisit when:
- Microsoft ships a stable Azure MCP image where
  `--dangerously-disable-http-incoming-auth` works, **or**
- The advertised OAuth tenant is correctly populated and we want to
  implement the OAuth flow on the backend.

---

## 6. Lifecycle stages (Build → View → Push → Tear-down)

The chat is constrained to one of five stages per turn — `build` (the
default), `view`, `push`, `teardown`, `free`. The stage is sent as a
field on the `/api/chat` body and surfaces inside the system prompt as
a per-request text block (after the cache breakpoint, so changing
stage doesn't invalidate the cached prefix).

- **build / view** — Claude must NOT mutate Azure. Inspect-only MCP
  tools (`*_list`, `*_show`, `*_get`) only. Claude ends every turn
  with a `<topology>{...}</topology>` JSON marker (parsed by the
  frontend → React Flow canvas) and a `<bicep>...</bicep>` marker
  (parsed → side drawer). Markers are stripped from displayed text.
- **push** — explicit user action ("Push to Azure" button). Claude
  is freed to call mutating tools and execute the Bicep. After a
  successful push, an updated `<topology>` marker reflects status.
- **teardown** — explicit user action. Claude finds resources tagged
  `azure-mcp-project = <name>` and deletes them.

The discipline is enforced **by prompt**, not by a tool-list filter.
That's deliberate — the Azure MCP server's tools are exposed by
namespace, and trying to denylist mutating sub-operations is fragile.
Claude reliably respects the stage instruction in practice. Revisit if
this turns out to be too loose.

Per-project build state (current topology, bicep, pushed flag) lives
in `localStorage` under `azure-mcp:build:<project_id>` so a reload
doesn't lose Claude's last proposal. Only the user-driven push moves
state to "pushed"; tear-down clears it.

---

## 7. Scheduler (cron-driven push and tear-down)

Schedules target a saved **template** (from the existing `templates`
table). When a cron fires, the in-process scheduler re-runs the chat
loop **non-streaming** with a hardcoded prompt that hands Claude the
template's Bicep and tells it to deploy (or, for teardown, to delete
all resources tagged with the project name). The same agentic loop
the streaming endpoint uses; just no SSE consumer.

Rationale (per the user-confirmed "hybrid" execution model):
- User-driven push/tear-down go through chat, with live SSE → the
  user sees Claude's reasoning and tool calls.
- Scheduled push/tear-down go through the same chat path but headless.

Trade-offs:
- ✓ Single execution path; no separate "backend-direct" engine to
  build and maintain.
- ✓ Claude handles MCP-tool-name selection, error recovery, and
  partial-state reasoning — all of which are hard to encode in a
  hand-rolled deploy engine.
- ✗ Each scheduled run costs Anthropic tokens (the system prompt + 63
  tool schemas + the build prompt). Mitigated by prompt caching on
  the static prefix.
- ✗ Headless runs lack a feedback channel — the next turn isn't
  available, so retries-on-failure require user intervention.

Storage: `schedules` table (idempotent on-startup migration in
`backend/src/db/migrate.ts`; also in `db/init.sql` for fresh installs).
Scheduling library: `node-cron` (5-field cron in UTC).

The cron tasks live in-memory in the backend process — there is **no**
durable distributed lock. If you ever run two backend replicas, both
will fire each schedule. Single-replica is fine for the homelab.

---

## 8. v1 simplifications (deliberate scope cuts)

These are choices I made to ship v1 quickly. None are technically hard
to fix; they're flagged here so they don't get lost.

- **Conversation history is user-only.** The frontend re-sends the user
  turns to `/api/chat` on every request; the backend's tool-use loop
  re-derives Claude's responses each time. This works because Claude is
  stateless and the prompt cache covers tools+system, but it means
  every turn re-runs the agentic loop from scratch. Upgrade path: have
  the frontend store the assistant's wire-format content blocks
  (including `tool_use` ids and `tool_result` blocks) and resubmit
  them. The hook leaves a hook for this — see `useChat.ts`.
- **Canvas not yet driven by Claude's tool calls.** The canvas renders
  hardcoded demo nodes via the "Load demo" button. Wiring it to
  Claude's proposals needs either a custom MCP-style tool
  (`set_topology`) that the backend forwards to the frontend via SSE,
  or a system-prompt convention (e.g. `<topology>{...}</topology>` in
  a turn). Both are easy follow-ups.
- **Deployment history is recorded by the frontend, not the backend.**
  `/api/deployments POST` is the recording endpoint; the chat loop
  doesn't auto-record. The frontend should call it after a chat turn
  whose tool calls included mutating Azure operations. v1 has the
  endpoint but no auto-record path yet.
- **Bicep review drawer not wired.** The backend exposes the right MCP
  tools (`bicepschema`, `deploy`); the chat loop will use them when
  asked. The "Review Bicep" / "Deploy live" UI buttons in the chat
  panel are pending — for v1 the user instructs Claude in plain
  English ("write the Bicep first; don't deploy yet" vs "deploy this
  now"). Same end result, less UI surface.
- **Azure resource icons are Material Symbols, not the official Microsoft
  set.** Chosen for shippability — no extra CDN config or licensing
  overhead. Visually consistent with netbud. Switch to the Microsoft
  Cloud Architecture icons in a polish pass once we settle on a CDN.
- **Auto-layout: dagre, left-to-right.** ELK is the upgrade if dagre's
  routing gets cramped on bigger architectures.
- **Cf-Access trusted-email check has a dev bypass.** The
  `trustedEmail` plugin allows requests with no `Cf-Access-...` header
  through when `NODE_ENV !== production`. This is what lets `npm run
  dev` work without faking headers. Production builds run with
  `NODE_ENV=production` (set in compose) so the check is enforced.

---

## 9. Things to revisit (Steven dislike → change)

- **Auto-layout = dagre, not ELK.** Revisit if the canvas gets cramped.
- **Tool-call rendering in chat = collapsed by default.** A "show all"
  toggle in settings.
- **Cf-Access identity check via header on every request.** No session
  cookie; the header is asserted on every hop by Cloudflare.
- **Default deploy mode = Review Bicep first** (safer first run).
  Switches per-user-preference once history exists (CLAUDE.md §4.3).
