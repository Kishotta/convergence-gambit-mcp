# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Bespoke, single-tenant MCP server (Cloudflare Worker + Durable Object) connecting Claude to the campaign's LegendKeeper wiki for "The Convergence Gambit" D&D campaign. Two clients only: Connor and Claude. No multi-tenancy, no database, no general-purpose design — the design philosophy is baked into source, not configuration.

**Current phase: walking skeleton, behind GitHub OAuth.** No LK API key yet. LegendKeeper calls are backed by an in-memory fake seeded with campaign data. Every tool now sits behind GitHub OAuth (`src/auth/`), allowlisted to exactly one GitHub account (`Kishotta`). The point of this phase is to prove the full path: Claude mobile app → custom connector → GitHub login → Cloudflare Worker → `LegendKeeperClient` seam. See README.md's "Phases" section for what comes next (custom domain, real client, charter-aware tools).

## Commands

```bash
npm install
npx wrangler login        # one-time, opens browser
npm run typecheck         # tsc --noEmit — run after any change
npm run dev               # local server at http://localhost:8787/mcp
npx wrangler deploy       # deploy (no npm script wraps this yet)
```

There is no test suite and no lint script currently configured. `npm run typecheck` is the only automated check — always run it before considering a change done.

`npm run dev` now requires `.dev.vars` populated (`GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `COOKIE_ENCRYPTION_KEY` — see README's "Authentication" section) or the OAuth-gated routes will 401/500 immediately.

Manual verification: `npx @modelcontextprotocol/inspector`, connect to `http://localhost:8787/mcp` (Streamable HTTP) — Inspector will walk through the GitHub login popup. The `/sse` and `/sse/message` routes exist only for legacy Inspector compatibility, and sit behind the same OAuth gate.

## Architecture: the seam

Everything meaningful lives behind one interface, `LegendKeeperClient` (`src/lk/types.ts`):

- `src/lk/types.ts` — the `LegendKeeperClient` interface plus all LK domain types (Resource, Document, Property, write inputs, `ProjectSnapshot`).
- `src/lk/fake.ts` — `FakeLegendKeeperClient`, an in-memory implementation seeded with a slice of real campaign data. State lives only for the Durable Object instance's lifetime.
- `src/lk/client.ts` — `createLegendKeeperClient()`, the single construction point for the seam. Both `src/index.ts` and `src/backup.ts` get their client from here.
- `src/index.ts` — the `ConvergenceGambitMCP` McpAgent and its tools. Tools talk **only** to the `LegendKeeperClient` interface, never to the fake directly by type.

When the real LegendKeeper API ships, a new `src/lk/http.ts` will implement `LegendKeeperClient` against the v2 endpoints, and exactly one line in `src/lk/client.ts` changes. No tool logic — nor `src/backup.ts` — should change at that cutover — if a change requires touching the fake's internals, something has leaked across the seam.

### Domain types are speculative — grep for SPEC-DRIFT

`src/lk/types.ts` was derived from a pre-release API docs screenshot. Every field whose shape is guessed is tagged `SPEC-DRIFT` in a comment. Three are called out as critical unknowns to verify the day real docs land:

1. **Does the API expose the visibility model** (`Resource.secret` / `DocumentSummary.secret`)? The entire architecture charter (see below) depends on element/tab/block secrecy. If the real API has no such field, every write tool must loudly warn that a manual secrecy pass is required — never silently publish spoilers.
2. **What format do `page` documents accept** for `LKDocument.content`? Assumed to be ProseMirror-style JSON, not markdown. Kept as `unknown` until confirmed; the eventual markdown→LK converter targets whatever this turns out to be.
3. **Does the API expose a whole-project export?** Unconfirmed — `LegendKeeperClient.exportProject()` and nightly backups (below) are stubbed against it.

When the real API lands, grep for `SPEC-DRIFT` and reconcile each tagged field before trusting it.

### Nightly backups (`src/backup.ts`)

A cron trigger (`triggers.crons` in `wrangler.jsonc`, currently `0 9 * * *`) invokes the Worker's `scheduled` handler in `src/index.ts`, which calls `runNightlyBackup(env)`. That function calls `LegendKeeperClient.exportProject()` (SPEC-DRIFT #3 above), writes the resulting `ProjectSnapshot` to the `BACKUPS` R2 bucket under `snapshots/YYYY-MM-DD.json`, and prunes anything older than 30 days (`RETENTION_DAYS` in `src/backup.ts`).

This is intentionally stubbed against the fake client — whether whole-project export is even possible on the real API is unknown, so the goal right now is only to prove the R2 write + retention-prune path, not to produce a real usable backup. Requires the `convergence-gambit-backups` R2 bucket to exist (already created; R2 must be enabled on the Cloudflare account via the dashboard, then `npx wrangler r2 bucket create convergence-gambit-backups`) before `wrangler dev` or `deploy` will work. To exercise the cron locally, with `npm run dev` running: `curl "http://localhost:8787/cdn-cgi/handler/scheduled"` — confirmed working end-to-end against the fake client and local R2 emulation.

### The charter (`src/charter.ts`)

`ARCHITECTURE_CHARTER` is the LegendKeeper Architecture & Presentation Charter, embedded verbatim as a template string and served by the `get_charter` tool. It is the authoritative convention set for how wiki articles are organized, layered for two audiences (players vs. DM), and written — home-vs-hook organizing principle, the four-level visibility model (element/tab/block/pin), tag-index-driven "Field Notes" and "DM Dashboard," etc. Any future tool that creates or restructures articles must follow these conventions; consult this file (or call `get_charter`) rather than re-deriving article structure conventions from scratch. When the charter changes, this file is edited and redeployed — it is *not* yet fetched from LK live; that migration happens later.

### MCP tool pattern

Tools are registered in `ConvergenceGambitMCP.init()` via `this.server.tool(name, description, zodShape, handler)`. Handlers return `text()` or `json()` (small helpers at the bottom of `src/index.ts` that wrap MCP's `{ content: [...] }` response shape). Errors from the `LegendKeeperClient` seam are caught in the handler and returned as `text(message, isError: true)` rather than thrown — see `get_resource` for the pattern to follow when adding new tools that hit the client.

### Authentication (`src/auth/`)

Every tool sits behind GitHub OAuth via `@cloudflare/workers-oauth-provider`. The default export in `src/index.ts` is an `OAuthProvider` instance (not the bare `fetch`/`scheduled` object from phase 1) whose `apiHandlers` map `/mcp` and `/sse` to `ConvergenceGambitMCP.serve(...)`/`.serveSSE(...)`, and whose `defaultHandler` is the Hono app in `src/auth/github-handler.ts`.

- `src/auth/github-handler.ts` — Hono app: `GET/POST /authorize` (approval dialog + redirect to GitHub) and `GET /callback` (exchanges the code, fetches the GitHub user, and — the one deliberate deviation from Cloudflare's reference pattern — hard-rejects any `login` other than `ALLOWED_GITHUB_LOGIN` with a 403 *before* `completeAuthorization` is ever called; no token is ever issued to anyone else). Also owns the custom 404 for stray paths (`app.notFound`).
- `src/auth/oauth-utils.ts` — CSRF token, HMAC-signed cookie, and approval-dialog rendering helpers. Ported near-verbatim from Cloudflare's `remote-mcp-github-oauth` reference; treat as hardened, don't casually edit.
- `src/auth/upstream.ts` — GitHub-specific token exchange (`fetchUpstreamAuthToken`) and authorize-URL building (`getUpstreamAuthorizeUrl`), plus the `Props` type (`{ login, name }`) that ends up on `this.props` inside `ConvergenceGambitMCP`.
- `src/env.ts` — the shared `Env` interface, imported by both `src/index.ts` and `src/auth/github-handler.ts`. Cloudflare's own reference relies on a *global* `Env` generated by `wrangler types`, which this repo doesn't run — that's also why `github-handler.ts` reads secrets via Hono's `c.env`, not an `import { env } from "cloudflare:workers"` ambient import (the ambient `env` resolves against the global `Env`, not this file's exported one, and silently fails to typecheck against our fields).

**Two credential pairs, don't cross them** (this caused real setup confusion — see README's "Authentication" section for the full story): the GitHub OAuth App's client id/secret authenticate *our Worker* to *GitHub* (`wrangler secret put GITHUB_CLIENT_ID`/`_SECRET`) and are never seen by Claude. Claude registers *itself* as an OAuth client of *our server* automatically via `/register` (RFC 7591) — nobody ever types that client id/secret in anywhere. If someone pastes the GitHub app's client id into Claude's connector setup, `/authorize` throws `Invalid client. The clientId provided does not match to this client.` (from `@cloudflare/workers-oauth-provider`, when `lookupClient` misses in `OAUTH_KV`).

### Env / secrets

`Env` (`src/env.ts`) declares `MCP_OBJECT` (Durable Object), `BACKUPS` (R2, nightly backups), `OAUTH_KV` (OAuth state + client-approval storage), and the three OAuth secrets: `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `COOKIE_ENCRYPTION_KEY`. All three secrets are real Worker secrets (`wrangler secret put`), not KV entries — don't add them as key-value pairs inside the `OAUTH_KV` namespace by mistake, they'd be inert there (the library only reads keys prefixed `client:...`) and wouldn't reach `env.*` at all. Local dev reads the same three names from `.dev.vars` (gitignored; `.dev.vars.example` documents the shape).

Do **not** add `LK_API_KEY` or similar as a Worker secret until the real client (README phase 4) actually needs it — auth is in place now, but there's still no reason to hold a real credential before something exercises it.

## Version drift note

The `agents` package (Cloudflare's `McpAgent`) moves fast and its idioms can shift between versions. If `npm install` or `npm run typecheck` fails in ways that look like an `agents`/SDK API mismatch, scaffold Cloudflare's current authless remote-MCP template into a scratch directory (`npm create cloudflare@latest -- scratch --template=cloudflare/ai/demos/remote-mcp-authless`) and copy its `package.json` dependency versions and any changed `McpAgent`/`serve` idioms into this repo — keep this repo's `src/` content as-is. The template is the authority on Worker/MCP plumbing; this repo is the authority on everything above the seam (charter, domain types, tools).
