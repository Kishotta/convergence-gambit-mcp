# The Convergence Gambit MCP Server

Bespoke, single-tenant MCP server connecting Claude to the campaign's
LegendKeeper wiki. Two clients, one project, design philosophy baked into
source. No multi-tenancy, no database, no apologies.

**Current state: walking skeleton, now behind GitHub OAuth.** No LK API key
yet, LegendKeeper calls backed by an in-memory fake seeded with campaign
data. Every tool now sits behind OAuth (see "Authentication" below) — only
GitHub account `Kishotta` is ever issued a token. Its job is to prove the
full path: Claude mobile app → custom connector → GitHub login → Cloudflare
Worker → `LegendKeeperClient` seam.

## Skeleton toolset

| Tool             | Purpose                                                  |
| ---------------- | -------------------------------------------------------- |
| `ping`           | Proves the transport.                                    |
| `get_charter`    | Serves the Architecture & Presentation Charter verbatim. |
| `list_resources` | Proves the client seam (fake-backed).                    |
| `get_resource`   | Proves parameterized reads.                              |

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
Claude to `ping` and `list_resources`. If Morte comes back, the skeleton
walks.

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
src/lk/types.ts   LegendKeeperClient + domain types (from the API screenshot)
src/lk/fake.ts    In-memory implementation, seeded with campaign articles
src/index.ts      MCP tools — talk only to the interface
```

When the real API ships, we add `src/lk/http.ts` implementing
`LegendKeeperClient` against the v2 endpoints and swap one constructor
call in `index.ts`. Tools never change at cutover.

Speculative type fields are tagged `SPEC-DRIFT` — grep for them when the
real docs land.

## Nightly backups (stub)

A cron trigger (`0 9 * * *` in `wrangler.jsonc`) calls `src/backup.ts`
nightly, which exports the project via `LegendKeeperClient.exportProject()`
and writes a snapshot to the `BACKUPS` R2 bucket (`convergence-gambit-backups`),
pruning anything older than 30 days.

Whether the real LegendKeeper API can export a whole project at all is
unconfirmed (`SPEC-DRIFT` **CRITICAL UNKNOWN #3** in `src/lk/types.ts`) —
today this runs against the fake client, which proves the R2 storage and
retention path end-to-end with fake data. When the real answer is known,
only `src/lk/client.ts` needs to change.

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
   "Authentication" above), allowlisted to `Kishotta` only. Only now, with
   auth in place, is it safe to move on to real LegendKeeper credentials:
   `npx wrangler secret put LK_API_KEY` / `LK_PROJECT_ID`.
3. **Custom domain** — point `connoreaves.dev` (or `kishotta.com`) DNS at
   Cloudflare, uncomment the route in `wrangler.jsonc`, redeploy to
   `mcp.connoreaves.dev`.
4. **Real client** — `src/lk/http.ts` against the shipped API.
5. **Charter-aware tools** — `create_npc_article`, `create_location_article`,
   `stage_reveal`, the markdown→LK converter. Designed only after phase 4
   confirms the two critical unknowns.

Phases 4 and 5 both trigger on the same event (LegendKeeper publishing the
v2 API docs) and are the reason this repo currently has nothing left to do
— see [`docs/real-api-cutover.md`](docs/real-api-cutover.md) for the full
runbook for that day, written up in advance so it isn't reconstructed from
scratch later.

## The two critical unknowns (verify the day the docs drop)

1. **Does the API expose the visibility model?** Element/tab/block secrecy
   is load-bearing for the whole architecture charter. If absent, every
   write tool must warn that a manual secrecy pass is required before the
   article is player-safe.
2. **What format do `page` documents accept?** Expected: ProseMirror-style
   JSON, not markdown. The converter targets whatever this turns out to be;
   until then `LKDocument.content` is deliberately `unknown`.
