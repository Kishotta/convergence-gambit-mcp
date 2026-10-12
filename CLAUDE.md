# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Bespoke, single-tenant MCP server (Cloudflare Worker + Durable Object) connecting Claude to the campaign's LegendKeeper wiki for "The Convergence Gambit" D&D campaign. Two clients only: Connor and Claude. No multi-tenancy, no database, no general-purpose design — the design philosophy is baked into source, not configuration.

**Current phase: read-side tools plus the first charter-aware write tool (`create_magic_item`), against the live LegendKeeper v3 API, behind GitHub OAuth.** Reads go through the official `@legendkeeper/sdk` behind the `LegendKeeperClient` seam; with no `LK_API_KEY` configured, an in-memory fake answers instead. Every tool sits behind GitHub OAuth (`src/auth/`), allowlisted to exactly one GitHub account (`Kishotta`). Next: more charter-aware write tools, one per kind of article, designed from how the existing ones get used. See README.md's "Phases" section.

## Commands

```bash
npm install
npx wrangler login        # one-time, opens browser
npm run typecheck         # tsc --noEmit — run after any change
npm run dev               # local server at http://localhost:8787/mcp
npx wrangler deploy       # manual deploy — normally CI does this (below)
```

There is no test suite and no lint script currently configured. `npm run typecheck` is the only automated check — always run it before considering a change done. `npx wrangler deploy --dry-run --outdir dist` additionally bundles the Worker exactly as a deploy would (no Cloudflare login needed), catching bad imports and Workers-incompatible modules that tsc can't.

**CI/CD** (`.github/workflows/ci.yml`): every pull request and push runs `npm ci`, typecheck and the dry-run bundle; a push to `main` then deploys via `cloudflare/wrangler-action` (GitHub environment `production`, one deploy at a time). So merging to `main` *is* deploying. The workflow holds only `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` (repo secrets); the Worker's runtime secrets stay in Cloudflare and `wrangler deploy` leaves them untouched — never add them to the workflow. `.github/dependabot.yml` opens a daily PR for each new `@legendkeeper/sdk` release so CI tests the upgrade against the seam before it ships.

`npm run dev` now requires `.dev.vars` populated (`GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `COOKIE_ENCRYPTION_KEY` — see README's "Authentication" section) or the OAuth-gated routes will 401/500 immediately.

Without `LK_API_KEY` in `.dev.vars` the fake answers (`ping` says which backend is live). With it, local dev reads the **real campaign project, DM secrets included** — mind where transcripts go.

Manual verification: `npx @modelcontextprotocol/inspector`, connect to `http://localhost:8787/mcp` (Streamable HTTP) — Inspector will walk through the GitHub login popup. The `/sse` and `/sse/message` routes exist only for legacy Inspector compatibility, and sit behind the same OAuth gate.

## Architecture: the seam

Everything meaningful lives behind one interface, `LegendKeeperClient` (`src/lk/types.ts`):

- `src/lk/types.ts` — the `LegendKeeperClient` interface (reads, plus the few writes a write tool has needed so far) plus LK domain types, re-exported type-only from the SDK's generated `components["schemas"]`. Everything above the seam imports LK types from here, never from `@legendkeeper/sdk` directly.
- `src/lk/sdk.ts` — `SdkLegendKeeperClient`, the **only runtime import of `@legendkeeper/sdk`**. Wraps SDK errors into messages carrying the API's `code` and `requestId`. Passes a wrapped `fetch` because the SDK calls `config.fetch(...)` as a method, which throws "Illegal invocation" on Workers with the bare global.
- `src/lk/fake.ts` — `FakeLegendKeeperClient`, in-memory, seeded in the real v3 shapes and deliberately exercising every visibility layer (hidden element + subtree, hidden tab, secret block, hidden property, visible text mentioning a hidden element; on maps and timelines: hidden pins and events, a pin auto-hidden by its link, a hidden folder), plus templates, including a Magic Item family shaped like the live one. Its write methods change the in-memory copy only.
- `src/lk/client.ts` — `createLegendKeeperClient(env)`, the single construction point: `LK_API_KEY` set → SDK client, else fake. Called in `McpAgent.init()` (needs `this.env`) and in `src/backup.ts`.
- `src/wiki/` — above the seam, SDK-free:
  - `index.ts` — `ResourceIndex`: the whole tree from one paged `listResources` walk. Answers what the API doesn't: **effective** player visibility (a hidden ancestor hides its subtree — the API only reports each resource's own `isHidden`), breadcrumb paths, tree order (siblings by `rank`, a plain string compare), tag filtering and per-tag player-visible counts. It also separates **templates**: `listResources` returns them with everything else, as resources under the virtual root `templates` (`TEMPLATES_ROOT_ID` in `src/lk/types.ts`; no resource has that id). They are skeletons, not wiki articles, so the index keeps them in a tree of their own, out of the root listing, tag queries and tag counts. The agent caches it for 60s (`INDEX_TTL_MS` in `src/index.ts`).
  - `render.ts` — block tree → markdown for an `Audience` (`"dm"` marks concealed layers inline; `"player"` drops them). Mentions render as `[Name](lk:resourceId)`. Collects "leaks" (player-visible text mentioning a player-hidden resource) in `ctx.leaks`.
  - `spatial.ts` — map tabs (pins, regions, labels, paths, folders as a tree) and timeline tabs (events by lane) → markdown, same audience/leak rules. A pin is just a link: on Sigil's map it may be a building or settlement, on a battle map a keyed room — never assume which. Visibility rules and their certainty are documented at the top of the file (pins linking hidden articles auto-hide per charter §2; hidden-folder cascade and event auto-hiding are unverified, and the player view errs toward *showing*).
  - `views.ts` — what each read tool returns, composed from seam calls + the index.
  - `compose.ts` — markdown → block tree, the write-side counterpart of `render.ts`: paragraphs, `- ` lists, bold, italic, links, and mentions as `[Name](lk:resourceId)`. Deliberately small; anything else stays literal text.
  - `items.ts` — `create_magic_item`: copies the Consumable, Equipment or Wondrous Item template (found by name under the `Magic Item` template), sets tags, and writes the body. Encodes the campaign's reveal rule (Common items show their mechanics; from Uncommon up they go in a secret block; a curse gets a secret block of its own) and always leaves the new article hidden. An optional web image is downloaded and stored in the asset library (folder `Magic Items`) first, because an image block only accepts a URL of one of the project's own assets. See the file header for the five parts of an item article.
- `src/index.ts` — the `ConvergenceGambitMCP` McpAgent and its tools. Tools talk **only** to the `LegendKeeperClient` interface and `src/wiki/`.

The SDK is a beta regenerated from the OpenAPI spec on every API release (three major versions in its first three days), pinned to an exact version in `package.json`. An SDK upgrade should touch only `src/lk/`; if it forces changes in `src/wiki/` or tools beyond type fallout, something leaked across the seam.

### Spec drift — grep for SPEC-DRIFT

The spec the pinned SDK was generated from ships inside it, at `node_modules/@legendkeeper/sdk/openapi.json`; the repo keeps no copy. The live API serves its current spec at `https://www.legendkeeper.com/api/v3/openapi.json` (public, but an undocumented path). There are no open `SPEC-DRIFT` tags right now. The spec's `info.version` is not a reliable marker (it still says `3.0.0`); the SDK's `CHANGELOG.md` and a structural diff are. When code has to touch a field the live API returns but the pinned SDK doesn't type yet, declare it optional in `src/lk/types.ts`, tag it `SPEC-DRIFT`, and never rely on it being present. Dependabot's PR for each SDK release is how API changes reach this repo; nothing polls the live spec. On an SDK upgrade, read `node_modules/@legendkeeper/sdk/CHANGELOG.md` and reconcile each tag; for a structural diff, `npm pack @legendkeeper/sdk@<previous version>` into a scratch directory and compare its `openapi.json` with the bundled one.

The three original critical unknowns are resolved: the API **does** expose the visibility model (`isHidden` on resources/documents/properties, `secret` blocks); page content is a **typed block tree** (the SDK's `@legendkeeper/sdk/blocks` has builders for the write side); there is **no** whole-project export.

### Nightly backups (`src/backup.ts`)

A cron trigger (`triggers.crons` in `wrangler.jsonc`, currently `0 9 * * *`) invokes the Worker's `scheduled` handler in `src/index.ts`, which calls `runNightlyBackup(env)`. With no export endpoint, it walks the project through the seam (every resource, every page's block tree, every map's features, every timeline's lanes and events), sequentially with `REQUEST_SPACING_MS` (500ms, ~120 req/min) between reads to stay well under the key's 300 req/min budget shared with live sessions. Individual read failures are recorded in the snapshot's `errors` and logged; a failed `listResources` aborts so an empty snapshot never looks good. Writes `snapshots/YYYY-MM-DD.json` to the `BACKUPS` R2 bucket and prunes anything older than 30 days (`RETENTION_DAYS`). Not captured yet: board content, assets, trash. To exercise locally, with `npm run dev` running: `curl "http://localhost:8787/cdn-cgi/handler/scheduled"`.

### The charter (`src/charter.ts`)

`ARCHITECTURE_CHARTER` is the LegendKeeper Architecture & Presentation Charter, embedded verbatim as a template string and served by the `get_charter` tool. It is the authoritative convention set for how wiki articles are organized, layered for two audiences (players vs. DM), and written — home-vs-hook organizing principle, the four-level visibility model (element/tab/block/pin), tag-index-driven "Field Notes" and "DM Dashboard," etc. Any future tool that creates or restructures articles must follow these conventions; consult this file (or call `get_charter`) rather than re-deriving article structure conventions from scratch. When the charter changes, this file is edited and redeployed — it is *not* yet fetched from LK live; that migration happens later.

### MCP tool pattern

Tools are registered in `ConvergenceGambitMCP.init()` via `this.server.tool(name, description, zodShape, handler)`. Handlers return `text()` or `json()` (small helpers at the bottom of `src/index.ts`), wrapped in `guard()`, which turns any thrown error from the seam into `text(message, isError: true)` rather than a protocol failure. Views that need the tree get it from `this.index()` (the cached `ResourceIndex`), never by calling `listResources` themselves. Read views take the shared `audience` zod param.

Tool output is markdown written for Claude to read, not raw API JSON: ids inline for follow-up calls, visibility explicit. The API key is ADMIN-role, so DM-only content is in every response by design; the `player` audience exists to *simulate* the player view, not as a security boundary.

### Authentication (`src/auth/`)

Every tool sits behind GitHub OAuth via `@cloudflare/workers-oauth-provider`. The default export in `src/index.ts` is an `OAuthProvider` instance (not the bare `fetch`/`scheduled` object from phase 1) whose `apiHandlers` map `/mcp` and `/sse` to `ConvergenceGambitMCP.serve(...)`/`.serveSSE(...)`, and whose `defaultHandler` is the Hono app in `src/auth/github-handler.ts`.

- `src/auth/github-handler.ts` — Hono app: `GET/POST /authorize` (approval dialog + redirect to GitHub) and `GET /callback` (exchanges the code, fetches the GitHub user, and — the one deliberate deviation from Cloudflare's reference pattern — hard-rejects any `login` other than `ALLOWED_GITHUB_LOGIN` with a 403 *before* `completeAuthorization` is ever called; no token is ever issued to anyone else). Also owns the custom 404 for stray paths (`app.notFound`).
- `src/auth/oauth-utils.ts` — CSRF token, HMAC-signed cookie, and approval-dialog rendering helpers. Ported near-verbatim from Cloudflare's `remote-mcp-github-oauth` reference; treat as hardened, don't casually edit.
- `src/auth/upstream.ts` — GitHub-specific token exchange (`fetchUpstreamAuthToken`) and authorize-URL building (`getUpstreamAuthorizeUrl`), plus the `Props` type (`{ login, name }`) that ends up on `this.props` inside `ConvergenceGambitMCP`.
- `src/env.ts` — the shared `Env` interface, imported by both `src/index.ts` and `src/auth/github-handler.ts`. Cloudflare's own reference relies on a *global* `Env` generated by `wrangler types`, which this repo doesn't run — that's also why `github-handler.ts` reads secrets via Hono's `c.env`, not an `import { env } from "cloudflare:workers"` ambient import (the ambient `env` resolves against the global `Env`, not this file's exported one, and silently fails to typecheck against our fields).

**Two credential pairs, don't cross them** (this caused real setup confusion — see README's "Authentication" section for the full story): the GitHub OAuth App's client id/secret authenticate *our Worker* to *GitHub* (`wrangler secret put GITHUB_CLIENT_ID`/`_SECRET`) and are never seen by Claude. Claude registers *itself* as an OAuth client of *our server* automatically via `/register` (RFC 7591) — nobody ever types that client id/secret in anywhere. If someone pastes the GitHub app's client id into Claude's connector setup, `/authorize` throws `Invalid client. The clientId provided does not match to this client.` (from `@cloudflare/workers-oauth-provider`, when `lookupClient` misses in `OAUTH_KV`).

### Env / secrets

`Env` (`src/env.ts`) declares `MCP_OBJECT` (Durable Object), `BACKUPS` (R2, nightly backups), `OAUTH_KV` (OAuth state + client-approval storage), and the three OAuth secrets: `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `COOKIE_ENCRYPTION_KEY`. All three secrets are real Worker secrets (`wrangler secret put`), not KV entries — don't add them as key-value pairs inside the `OAUTH_KV` namespace by mistake, they'd be inert there (the library only reads keys prefixed `client:...`) and wouldn't reach `env.*` at all. Local dev reads the same three names from `.dev.vars` (gitignored; `.dev.vars.example` documents the shape).

`LK_API_KEY` (optional `LK_PROJECT_ID`) is a Worker secret (`wrangler secret put`) and a `.dev.vars` entry. It must be an **ADMIN-role** project key: a lesser key silently omits hidden resources, hidden tabs and secret blocks, which would make every visibility answer wrong. Keys also require the project owner on a paid plan (`402 PAID_PLAN_REQUIRED` otherwise).

## Version drift note

The `agents` package (Cloudflare's `McpAgent`) moves fast and its idioms can shift between versions. If `npm install` or `npm run typecheck` fails in ways that look like an `agents`/SDK API mismatch, scaffold Cloudflare's current authless remote-MCP template into a scratch directory (`npm create cloudflare@latest -- scratch --template=cloudflare/ai/demos/remote-mcp-authless`) and copy its `package.json` dependency versions and any changed `McpAgent`/`serve` idioms into this repo — keep this repo's `src/` content as-is. The template is the authority on Worker/MCP plumbing; this repo is the authority on everything above the seam (charter, domain types, tools).
