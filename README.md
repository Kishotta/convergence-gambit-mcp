# The Convergence Gambit MCP Server

Bespoke, single-tenant MCP server connecting Claude to the campaign's
LegendKeeper wiki. Two clients, one project, design philosophy baked into
source. No multi-tenancy, no database, no apologies.

**Current state: walking skeleton.** Authless, no LK API key, LegendKeeper
calls backed by an in-memory fake seeded with campaign data. Its job is to
prove the full path: Claude mobile app → custom connector → Cloudflare
Worker → `LegendKeeperClient` seam.

## Skeleton toolset

| Tool | Purpose |
|---|---|
| `ping` | Proves the transport. |
| `get_charter` | Serves the Architecture & Presentation Charter verbatim. |
| `list_resources` | Proves the client seam (fake-backed). |
| `get_resource` | Proves parameterized reads. |

## Setup (day one)

Prereqs: Node 18+, a free Cloudflare account.

```bash
npm install
npx wrangler login        # opens browser, authorizes wrangler
npm run typecheck         # sanity check
npm run dev               # local server at http://localhost:8787/mcp
npm run deploy            # → https://convergence-gambit-mcp.<account>.workers.dev
```

Optional local verification before deploying:

```bash
npx @modelcontextprotocol/inspector
# connect to http://localhost:8787/mcp (Streamable HTTP)
```

Then on the phone: **Customize → Connectors → Add custom connector**, paste
`https://convergence-gambit-mcp.<account>.workers.dev/mcp`, and ask Claude
to `ping` and `list_resources`. If Morte comes back, the skeleton walks.

> **Version drift note.** The `agents` package (Cloudflare's `McpAgent`)
> moves fast. If `npm install` or `typecheck` complains, scaffold Cloudflare's
> current authless remote-MCP template into a scratch directory
> (`npm create cloudflare@latest -- scratch --template=cloudflare/ai/demos/remote-mcp-authless`),
> copy its `package.json` dependency versions and any changed
> `McpAgent`/`serve` idioms into this repo, and keep our `src/` content.
> The template is the authority on plumbing; this repo is the authority on
> everything above the seam.

## The seam

Everything meaningful lives behind one interface:

```
src/lk/types.ts   LegendKeeperClient + domain types (from the API screenshot)
src/lk/fake.ts    In-memory implementation, seeded with campaign articles
src/index.ts      MCP tools — talk only to the interface
```

When the real API ships, we add `src/lk/http.ts` implementing
`LegendKeeperClient` against the v2 endpoints and swap one constructor
call in `index.ts`. Tools never change at cutover.

Speculative type fields are tagged `SPEC-DRIFT` — grep for them when the
real docs land.

## Phases

1. **Walking skeleton** *(this repo)* — authless, fake-backed, deployed,
   connected from the phone.
2. **Auth** — before any real credentials enter the Worker. Claude's custom
   connectors support OAuth only (no static bearer tokens, no keys in
   URLs), so: adopt the GitHub-OAuth remote-MCP template pattern, allowlist
   Connor's GitHub account, then and only then
   `npx wrangler secret put LK_API_KEY` / `LK_PROJECT_ID`.
3. **Custom domain** — point `connoreaves.dev` (or `kishotta.com`) DNS at
   Cloudflare, uncomment the route in `wrangler.jsonc`, redeploy to
   `mcp.connoreaves.dev`.
4. **Real client** — `src/lk/http.ts` against the shipped API.
5. **Charter-aware tools** — `create_npc_article`, `create_location_article`,
   `stage_reveal`, the markdown→LK converter. Designed only after phase 4
   confirms the two critical unknowns.

## The two critical unknowns (verify the day the docs drop)

1. **Does the API expose the visibility model?** Element/tab/block secrecy
   is load-bearing for the whole architecture charter. If absent, every
   write tool must warn that a manual secrecy pass is required before the
   article is player-safe.
2. **What format do `page` documents accept?** Expected: ProseMirror-style
   JSON, not markdown. The converter targets whatever this turns out to be;
   until then `LKDocument.content` is deliberately `unknown`.
