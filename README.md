# The Convergence Gambit MCP Server

Bespoke, single-tenant MCP server connecting Claude to the campaign's
LegendKeeper wiki. Two clients, one project, design philosophy baked into
source. No multi-tenancy, no database, no apologies.

**Current state: read-side tools against the live LegendKeeper v3 API,
behind GitHub OAuth.** Reads go through the official `@legendkeeper/sdk`
behind the `LegendKeeperClient` seam; without an `LK_API_KEY` an
in-memory fake answers instead. Every tool sits behind OAuth (see
"Authentication" below) — only GitHub account `Kishotta` is ever issued a
token. Write tools come next, designed from what the read tools teach us.

## Read-side toolset

| Tool              | Purpose                                                                  |
| ----------------- | ------------------------------------------------------------------------ |
| `ping`            | Proves the transport; says whether the live project or the fake answers. |
| `get_charter`     | Serves the Architecture & Presentation Charter verbatim.                 |
| `get_tree`        | The project hierarchy as an outline, hidden resources marked.            |
| `read_article`    | One article as markdown: visibility, properties, every tab.              |
| `search`          | LegendKeeper full-text search with matching passages.                    |
| `find_by_tag`     | Tag-index queries — DM Dashboard / Field Notes previews.                 |
| `list_tags`       | Tag usage, with how many carriers players can see.                       |
| `get_page_blocks` | Raw block JSON for one tab (debugging, write planning).                  |

Every view except `search` takes `audience`: `dm` (default — everything,
with hidden tabs, secret blocks and hidden properties marked inline) or
`player` (only what players can see right now). `read_article` also
flags player-visible text that names a hidden article, the charter's "one
accepted leak".

## Setup (day one)

Prereqs: Node 18+, a free Cloudflare account.

```bash
npm install
npx wrangler login        # opens browser, authorizes wrangler
npm run typecheck         # sanity check
npm run dev               # local server at http://localhost:8787/mcp
npx wrangler deploy       # → https://convergence-gambit-mcp.<account>.workers.dev
```

Optional local verification before deploying:

```bash
npx @modelcontextprotocol/inspector
# connect to http://localhost:8787/mcp (Streamable HTTP)
# Inspector will walk you through the GitHub login popup — see Authentication below
```

Then on the phone: **Customize → Connectors → Add custom connector**, paste
`https://convergence-gambit-mcp.<account>.workers.dev/mcp`. Claude will
prompt a GitHub login before the connector activates. Once connected, ask
Claude to `ping` (it reports live vs. fake) and `get_tree`.

## Authentication

Every tool sits behind GitHub OAuth (`@cloudflare/workers-oauth-provider` +
a GitHub-OAuth `defaultHandler`, in `src/auth/`). No token is ever issued to
any GitHub account other than `Kishotta` — the callback in
`src/auth/github-handler.ts` rejects everyone else with a 403 before
`completeAuthorization` is ever called. This is stricter than Cloudflare's
own reference pattern (which authenticates any GitHub user and just hides
extra tools) because the campaign data behind these tools is
spoiler-sensitive, not just at mutation risk.

**One-time setup**, before `wrangler dev` or `deploy` will work:

1. Create **two** GitHub OAuth Apps at
   [github.com/settings/developers](https://github.com/settings/developers)
   → OAuth Apps → New OAuth App:
   - **Dev**: Authorization callback URL `http://localhost:8787/callback`
   - **Prod**: Authorization callback URL
     `https://convergence-gambit-mcp.<account>.workers.dev/callback`
     (or the custom domain, once phase 3 lands — a new callback URL is
     needed on that cutover too)
2. Create the KV namespace OAuthProvider needs for state + client-approval
   storage (already done for this repo; re-run only if it's ever deleted):
   ```bash
   npx wrangler kv namespace create OAUTH_KV
   # paste the resulting id into wrangler.jsonc's kv_namespaces binding
   ```
3. Local dev: copy `.dev.vars.example` to `.dev.vars` (gitignored) and fill
   in the **dev** app's client id/secret, plus a random
   `COOKIE_ENCRYPTION_KEY` (any random string — used to HMAC-sign the
   client-approval cookie):
   ```bash
   node -e "console.log(crypto.randomUUID())"
   ```
4. Production secrets, from the **prod** app:
   ```bash
   npx wrangler secret put GITHUB_CLIENT_ID
   npx wrangler secret put GITHUB_CLIENT_SECRET
   npx wrangler secret put COOKIE_ENCRYPTION_KEY   # can reuse the dev value or generate a new one
   ```

Once all three secrets exist in both places, `npm run dev` / `wrangler
deploy` work as before, just with GitHub login gating `/mcp` and `/sse`.

> **Two different "Client ID"s — don't cross them.** This tripped us up on
> first deploy. There are two unrelated OAuth relationships stacked here:
>
> | | Who authenticates to whom | Where the credential lives |
> |---|---|---|
> | GitHub OAuth App | our Worker → github.com | `wrangler secret put GITHUB_CLIENT_ID` / `_SECRET` — never touched by Claude |
> | This server's own OAuth clients | Claude → our Worker | auto-registered by Claude itself via `/register` (RFC 7591) — nobody ever types this in |
>
> When adding the custom connector in Claude, enter **only the server URL**
> and leave any Client ID / Client Secret fields blank. If you paste the
> GitHub OAuth App's credentials into Claude's connector setup, `/authorize`
> will fail with `Invalid client. The clientId provided does not match to
> this client.` (thrown by `@cloudflare/workers-oauth-provider` when it
> can't find that client_id in `OAUTH_KV` — because it was never registered
> there in the first place). Also: Worker secrets and KV are different
> storage systems — don't add `GITHUB_CLIENT_ID` etc. as KV key-value pairs
> in the `OAUTH_KV` namespace's dashboard browser; `wrangler secret put` (or
> the dashboard's Variables & Secrets tab) is the only thing that actually
> reaches `env.GITHUB_CLIENT_ID` in the Worker.

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
src/lk/types.ts   LegendKeeperClient + LK types (re-exported from the SDK)
src/lk/sdk.ts     Live implementation over @legendkeeper/sdk — the only runtime SDK import
src/lk/fake.ts    In-memory implementation for keyless local dev
src/lk/client.ts  Picks one: LK_API_KEY set → SDK, else fake
src/wiki/         Above the seam: resource index, block→markdown renderer, views
src/index.ts      MCP tools — talk only to the interface and src/wiki/
```

The SDK is a beta regenerated on every API release, so it is pinned to an
exact version and confined to `src/lk/`. Upgrading it should mean editing
`sdk.ts`/`types.ts`, never the tools. Fields the newer spec in `docs/` has
but the pinned SDK doesn't type yet are tagged `SPEC-DRIFT` in
`src/lk/types.ts`.

## Nightly backups

A cron trigger (`0 9 * * *` in `wrangler.jsonc`) calls `src/backup.ts`
nightly. The v3 API has no whole-project export, so the backup walks the
project through the seam (every resource, every page tab's block tree),
throttled to ~120 requests/minute to leave the key's 300/minute budget for
live use, and writes one snapshot to the `BACKUPS` R2 bucket
(`convergence-gambit-backups`), pruning anything older than 30 days. Map,
board and timeline content isn't captured yet.

One-time setup before this can deploy: R2 must be enabled on the Cloudflare
account (dashboard only, not scriptable), then create the bucket:

```bash
npx wrangler r2 bucket create convergence-gambit-backups
```

To exercise the cron locally, with `npm run dev` already running:
`curl "http://localhost:8787/cdn-cgi/handler/scheduled"`.

## Phases

1. **Walking skeleton** _(done)_ — authless, fake-backed, deployed,
   connected from the phone.
2. **Auth** _(done)_ — GitHub OAuth in front of every tool (see
   "Authentication" above), allowlisted to `Kishotta` only.
3. **Custom domain** — point `connoreaves.dev` (or `kishotta.com`) DNS at
   Cloudflare, uncomment the route in `wrangler.jsonc`, redeploy to
   `mcp.connoreaves.dev`.
4. **Real client, read side** _(done)_ — `src/lk/sdk.ts` over the official
   SDK, plus the read tools above. Needs `npx wrangler secret put LK_API_KEY`
   (an ADMIN-role project key; `LK_PROJECT_ID` optional).
5. **Charter-aware write tools** — `create_npc_article`,
   `create_location_article`, `stage_reveal`, the markdown→blocks
   converter. Designed from real usage of the read tools.

## What the real API answered

1. **Visibility model: exposed.** `isHidden` on resources, documents (tabs)
   and properties, and `secret` blocks. Effective visibility (a hidden
   ancestor hides its subtree) is computed in `src/wiki/index.ts`.
2. **Page format: a typed block tree**, not ProseMirror and not markdown.
   The SDK ships block builders (`@legendkeeper/sdk/blocks`) the write side
   can target.
3. **Whole-project export: none.** The nightly backup synthesizes one.
