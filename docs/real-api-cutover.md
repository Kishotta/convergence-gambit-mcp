# Cutting over to the real LegendKeeper API

**When to use this:** LegendKeeper publishes the v2 API docs / OpenAPI spec
(README phase 4). Until then there's genuinely nothing else to do — this
repo is deliberately stalled at "walking skeleton + OAuth" waiting on an
external dependency. This is the runbook for the day it drops.

Read this alongside README's "The seam" and "The two critical unknowns"
sections, and CLAUDE.md's "Domain types are speculative" section — this
doc assumes that context rather than repeating it.

## Step 0: Reconcile SPEC-DRIFT against the real spec

Grep the codebase for `SPEC-DRIFT` (`src/lk/types.ts`, `src/backup.ts`).
Each tag maps to one of three critical unknowns — resolve all three against
the real docs before writing any code:

1. **Visibility model.** Does the API expose element/tab/block secrecy
   (`Resource.secret`, `DocumentSummary.secret`)? This is load-bearing for
   the entire architecture charter (`src/charter.ts`).
   - If yes: update the field names/shapes in `src/lk/types.ts` to match
     reality, drop the `SPEC-DRIFT` tag.
   - If no: **do not silently drop the field.** Every future write tool
     (phase 5) must refuse to finish, or return a loud warning, that a
     manual secrecy pass is required in the LK UI before the article is
     player-safe. This is a hard product requirement from the charter, not
     a nice-to-have.
2. **Page document content format** (`LKDocument.content`, currently
   `unknown`). Confirm the real shape (ProseMirror JSON was the guess).
   Update the type, and note it — the eventual markdown→LK converter
   (phase 5) targets exactly this shape.
3. **Whole-project export** (`LegendKeeperClient.exportProject()`, backing
   the nightly cron in `src/backup.ts`). Confirm whether a project-level
   export endpoint exists at all.
   - If yes: implement it directly in `src/lk/http.ts`.
   - If no: `src/backup.ts` needs a fallback — synthesize a "snapshot" by
     calling `listResources()` then `getResource()` for every id and
     bundling the results client-side. `runNightlyBackup` and the R2
     write/retention logic don't need to change either way; only what
     `exportProject()` does internally changes.

## Step 1: Store the real credentials

Safe now — OAuth (phase 2) is what this was gated on. Add to `src/env.ts`:

```ts
LK_API_KEY: string;
LK_PROJECT_ID: string;
```

Then:

```bash
npx wrangler secret put LK_API_KEY
npx wrangler secret put LK_PROJECT_ID
```

...and the same two names in `.dev.vars` for local dev (update
`.dev.vars.example` too).

## Step 2: Implement `src/lk/http.ts`

Implements the `LegendKeeperClient` interface (`src/lk/types.ts`) against
the real v2 endpoints. A few things worth getting right from the start:

- **Match the fake's error behavior.** `FakeLegendKeeperClient.getResource`
  throws `Error("Resource not found: ...")` on a miss, and the `get_resource`
  tool in `src/index.ts` already catches that and returns it as a tool
  error — don't change the tool, make the HTTP client throw comparably
  (e.g. on a 404) so that code path keeps working unchanged.
- **Auth header shape** depends entirely on what the spec says (bearer
  token vs. custom header vs. query param) — don't guess ahead of the
  spec, that's the whole reason this repo stalled here.
- Everything above the seam (tools, `src/backup.ts`) should need **zero**
  changes once this file satisfies the interface. If you find yourself
  editing `src/index.ts` to make the real client work, something has
  leaked across the seam — stop and reconsider.

## Step 3: Swap the seam in `src/lk/client.ts`

Today:

```ts
export function createLegendKeeperClient(): LegendKeeperClient {
    return new FakeLegendKeeperClient();
}
```

This becomes something like:

```ts
export function createLegendKeeperClient(env: Env): LegendKeeperClient {
    return new HttpLegendKeeperClient(env.LK_API_KEY, env.LK_PROJECT_ID);
}
```

(Or branch on `env.LK_API_KEY` presence to fall back to the fake for local
dev without real credentials — worth deciding at the time rather than
prescribing now.)

**Gotcha to check when you get here:** `src/index.ts` currently constructs
the client as a class field initializer —
`private lk: LegendKeeperClient = createLegendKeeperClient();` — which runs
during `McpAgent` construction. Once the factory needs `env`, confirm
`this.env` is actually populated at field-initializer time in whatever
version of the `agents` package is current then (this moves fast — see the
"Version drift note"). If it isn't, move the construction into `init()`
instead, which definitely has `this.env` available:

```ts
private lk!: LegendKeeperClient;

async init() {
    this.lk = createLegendKeeperClient(this.env);
    // ...existing tool registrations unchanged
}
```

`src/backup.ts`'s `runNightlyBackup` also calls `createLegendKeeperClient()`
with no args today — update that call site too.

## Step 4: Test against production data carefully

There's no sandbox LegendKeeper project — testing reads real campaign data,
including DM-only secrets, the moment the real client is wired up. Fine for
Connor's own use, but worth being deliberate about:

1. Wire up **read-only** first (`listResources`, `getResource`) and verify
   through Claude before touching anything else.
2. Any automated verification pass (including one run by a coding agent)
   that calls these tools against production will surface real spoilers in
   its output/transcript — that's expected, not a bug, but be mindful of
   where that transcript ends up.
3. Redeploy, reconnect via Claude, confirm `list_resources`/`get_resource`
   return real Sigil/NPC data instead of the fake's seed data.

## Step 5: Phase 5 — charter-aware write tools

Only after phase 4 is solid and both critical unknowns (visibility model,
content format) are confirmed. `create_npc_article`, `create_location_article`,
`stage_reveal`, and the markdown→LK converter all need to:

- Default to **secret/hidden** on creation if the visibility model exists —
  reveal is an explicit, separate action, never the default.
- If the visibility model turned out **not** to exist (Step 0.1), every one
  of these tools must return a prominent warning that a manual secrecy pass
  in the LK UI is required before the article is player-safe. This isn't
  optional — it's the whole point of gating write tools behind OAuth in the
  first place (see README's phase 2 rationale).
- Target the confirmed `LKDocument.content` shape from Step 0.2 for the
  converter.

## Step 6: Housekeeping

- Remove resolved `SPEC-DRIFT` tags from `src/lk/types.ts` (or update them
  to record what was actually confirmed, for posterity).
- Update README's "The two critical unknowns" section — either resolve it
  away entirely or record the answers.
- Update CLAUDE.md's "Domain types are speculative" section the same way.
- Update README's "Phases" list to mark phase 4 (and 5, once built) done.

## Unrelated to all of the above: phase 3 (custom domain)

Not gated on the API at all — can happen whenever. Point `connoreaves.dev`
or `kishotta.com` DNS at Cloudflare, uncomment the `routes` block in
`wrangler.jsonc`, redeploy. Remember the GitHub OAuth App's callback URL
needs a matching update the day this happens (see README's "Authentication"
section) — same gotcha as the dev/prod split, just a third callback URL.
