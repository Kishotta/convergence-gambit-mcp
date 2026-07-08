# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Bespoke, single-tenant MCP server (Cloudflare Worker + Durable Object) connecting Claude to the campaign's LegendKeeper wiki for "The Convergence Gambit" D&D campaign. Two clients only: Connor and Claude. No multi-tenancy, no database, no general-purpose design — the design philosophy is baked into source, not configuration.

**Current phase: walking skeleton.** Authless, no LK API key. LegendKeeper calls are backed by an in-memory fake seeded with campaign data. The point of this phase is to prove the full path: Claude mobile app → custom connector → Cloudflare Worker → `LegendKeeperClient` seam. See README.md's "Phases" section for what comes next (auth, custom domain, real client, charter-aware tools).

## Commands

```bash
npm install
npx wrangler login        # one-time, opens browser
npm run typecheck         # tsc --noEmit — run after any change
npm run dev               # local server at http://localhost:8787/mcp
npx wrangler deploy       # deploy (no npm script wraps this yet)
```

There is no test suite and no lint script currently configured. `npm run typecheck` is the only automated check — always run it before considering a change done.

Manual verification: `npx @modelcontextprotocol/inspector`, connect to `http://localhost:8787/mcp` (Streamable HTTP). The `/sse` and `/sse/message` routes exist only for legacy Inspector compatibility.

## Architecture: the seam

Everything meaningful lives behind one interface, `LegendKeeperClient` (`src/lk/types.ts`):

- `src/lk/types.ts` — the `LegendKeeperClient` interface plus all LK domain types (Resource, Document, Property, write inputs).
- `src/lk/fake.ts` — `FakeLegendKeeperClient`, an in-memory implementation seeded with a slice of real campaign data. State lives only for the Durable Object instance's lifetime.
- `src/index.ts` — the `ConvergenceGambitMCP` McpAgent and its tools. Tools talk **only** to the `LegendKeeperClient` interface, never to the fake directly by type.

When the real LegendKeeper API ships, a new `src/lk/http.ts` will implement `LegendKeeperClient` against the v2 endpoints, and exactly one constructor call in `index.ts` (`private lk: LegendKeeperClient = new FakeLegendKeeperClient()`) changes. No tool logic should change at that cutover — if a change to a tool requires touching the fake's internals, something has leaked across the seam.

### Domain types are speculative — grep for SPEC-DRIFT

`src/lk/types.ts` was derived from a pre-release API docs screenshot. Every field whose shape is guessed is tagged `SPEC-DRIFT` in a comment. Two are called out as critical unknowns to verify the day real docs land:

1. **Does the API expose the visibility model** (`Resource.secret` / `DocumentSummary.secret`)? The entire architecture charter (see below) depends on element/tab/block secrecy. If the real API has no such field, every write tool must loudly warn that a manual secrecy pass is required — never silently publish spoilers.
2. **What format do `page` documents accept** for `LKDocument.content`? Assumed to be ProseMirror-style JSON, not markdown. Kept as `unknown` until confirmed; the eventual markdown→LK converter targets whatever this turns out to be.

When the real API lands, grep for `SPEC-DRIFT` and reconcile each tagged field before trusting it.

### The charter (`src/charter.ts`)

`ARCHITECTURE_CHARTER` is the LegendKeeper Architecture & Presentation Charter, embedded verbatim as a template string and served by the `get_charter` tool. It is the authoritative convention set for how wiki articles are organized, layered for two audiences (players vs. DM), and written — home-vs-hook organizing principle, the four-level visibility model (element/tab/block/pin), tag-index-driven "Field Notes" and "DM Dashboard," etc. Any future tool that creates or restructures articles must follow these conventions; consult this file (or call `get_charter`) rather than re-deriving article structure conventions from scratch. When the charter changes, this file is edited and redeployed — it is *not* yet fetched from LK live; that migration happens later.

### MCP tool pattern

Tools are registered in `ConvergenceGambitMCP.init()` via `this.server.tool(name, description, zodShape, handler)`. Handlers return `text()` or `json()` (small helpers at the bottom of `src/index.ts` that wrap MCP's `{ content: [...] }` response shape). Errors from the `LegendKeeperClient` seam are caught in the handler and returned as `text(message, isError: true)` rather than thrown — see `get_resource` for the pattern to follow when adding new tools that hit the client.

### Env / secrets

`Env` in `src/index.ts` currently only declares `MCP_OBJECT` (the Durable Object binding). Do **not** add `LK_API_KEY` or similar as a Worker secret until OAuth is implemented (README phase 2) — this skeleton is deliberately authless, and adding real credentials before auth exists is a live security concern, not just a TODO.

## Version drift note

The `agents` package (Cloudflare's `McpAgent`) moves fast and its idioms can shift between versions. If `npm install` or `npm run typecheck` fails in ways that look like an `agents`/SDK API mismatch, scaffold Cloudflare's current authless remote-MCP template into a scratch directory (`npm create cloudflare@latest -- scratch --template=cloudflare/ai/demos/remote-mcp-authless`) and copy its `package.json` dependency versions and any changed `McpAgent`/`serve` idioms into this repo — keep this repo's `src/` content as-is. The template is the authority on Worker/MCP plumbing; this repo is the authority on everything above the seam (charter, domain types, tools).
