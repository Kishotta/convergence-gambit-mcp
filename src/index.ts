/**
 * The Convergence Gambit MCP server.
 *
 * Bespoke, single-tenant, two clients (Connor and Claude). The design
 * philosophy is baked into source, not configuration: this server exists
 * to make LegendKeeper article work follow the architecture charter.
 *
 * Read-side toolset:
 *   - ping            proves the transport; reports which LK backend answers
 *   - get_charter     serves the architecture charter verbatim
 *   - get_tree        the project hierarchy as an outline
 *   - list_templates  the article skeletons new resources can be copied from
 *   - read_article    one article, every tab, rendered to markdown
 *   - search          LegendKeeper full-text search
 *   - find_by_tag     tag-index queries (DM Dashboard / Field Notes previews)
 *   - list_tags       tag usage, with a player-safety count per tag
 *   - get_page_blocks raw block JSON, for debugging and write-tool planning
 *
 * Write-side toolset, one charter-aware tool per kind of article:
 *   - create_magic_item  a new, hidden item from the Magic Item templates
 *
 * The views take an audience: "dm" (everything, concealed layers marked)
 * or "player" (only what's revealed). See src/wiki/.
 *
 * GitHub OAuth (src/auth/) fronts every tool. No token is ever issued to a
 * GitHub account other than the one allowlisted in
 * src/auth/github-handler.ts — see that file for why this is stricter than
 * Cloudflare's reference "authenticate anyone, hide extra tools" pattern.
 *
 * Reads the live project when LK_API_KEY is set (see src/lk/client.ts).
 * That key is ADMIN-role, so tool output includes DM-only secrets by design.
 */

import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { z } from "zod";

import { ARCHITECTURE_CHARTER } from "./charter";
import { runNightlyBackup } from "./backup";
import { GitHubHandler } from "./auth/github-handler";
import type { Props } from "./auth/upstream";
import type { Env } from "./env";
import { createLegendKeeperClient } from "./lk/client";
import type { LegendKeeperClient } from "./lk/types";
import { ResourceIndex } from "./wiki/index";
import { createMagicItem, ITEM_KINDS, RARITIES, type ItemKind } from "./wiki/items";
import { articleView, searchView, taggedView, tagsView, templatesView, treeView } from "./wiki/views";

/**
 * How long a ResourceIndex snapshot is reused. Long enough that a burst of
 * tool calls shares one tree walk; short enough that a reveal Connor just
 * made in the app shows up within a minute.
 */
const INDEX_TTL_MS = 60_000;

const audience = z
    .enum(["dm", "player"])
    .default("dm")
    .describe(
        '"dm" (default): everything, with hidden tabs, secret blocks and hidden properties marked. ' +
            '"player": only what players can currently see, for reveal-layer checks.',
    );

export class ConvergenceGambitMCP extends McpAgent<Env, Record<string, never>, Props> {
    server = new McpServer({
        name: "The Convergence Gambit",
        version: "0.2.0",
    });

    /** The seam. Every tool reads LegendKeeper through this and nothing else. */
    private lk!: LegendKeeperClient;

    private indexCache?: { loadedAt: number; index: Promise<ResourceIndex> };

    async init() {
        this.lk = createLegendKeeperClient(this.env);

        this.server.tool(
            "ping",
            "Health check. Proves the Convergence Gambit MCP server is alive and says whether it is " +
                "reading the live LegendKeeper project or the offline fake.",
            {},
            async () =>
                text(
                    "The Lady's shadow falls across the skeleton, and it walks. (pong)\n" +
                        (this.lk.backend === "legendkeeper"
                            ? "Backend: live LegendKeeper project."
                            : "Backend: in-memory FAKE (no LK_API_KEY configured). Data is seed data, not the campaign."),
                ),
        );

        this.server.tool(
            "get_charter",
            "Returns the LegendKeeper Architecture & Presentation Charter — the authoritative " +
                "conventions for how Convergence Gambit wiki articles are organized, layered for " +
                "two audiences, and written. Consult before creating or restructuring any article.",
            {},
            async () => text(ARCHITECTURE_CHARTER),
        );

        this.server.tool(
            "get_tree",
            "The wiki's hierarchy as an indented outline: name, id, tags, and 🔒 on hidden resources. " +
                "Start here to orient, or pass rootId to see one branch (e.g. everything under Sigil). " +
                "Templates are listed apart from the wiki, after it.",
            {
                rootId: z.string().optional().describe("Only this resource and its descendants."),
                maxDepth: z
                    .number()
                    .int()
                    .min(1)
                    .optional()
                    .describe("Levels to show below the root; deeper branches show as '…'."),
                audience,
            },
            async ({ rootId, maxDepth, audience }) =>
                guard(async () => text(treeView(await this.index(), { rootId, maxDepth, audience }))),
        );

        this.server.tool(
            "list_templates",
            "The project's templates (reusable article skeletons such as Character or Session) as an " +
                "outline: name, id, tags, tabs, and any nested resources that are copied with them. " +
                "Templates are not wiki articles; pass an id to read_article to see a skeleton's content.",
            {},
            async () => guard(async () => text(templatesView(await this.index()))),
        );

        this.server.tool(
            "read_article",
            "Reads one wiki article (resource) as markdown: its place in the tree, player visibility, " +
                "tags, sidebar properties, and every tab's content: pages as text, maps as their pins, " +
                "regions, labels and folders, timelines as events by lane. Links render as [Name](lk:id); " +
                "pass that id back here to follow them. Flags player-visible content that links to " +
                "hidden articles (the charter's reveal-layer check). A pin may stand for a room, a " +
                "building or a whole settlement depending on the map; read the linked article to know which.",
            {
                resourceId: z.string().describe("The resource id, from get_tree, search or a mention."),
                documentId: z.string().optional().describe("Only this tab. Default: every tab."),
                audience,
            },
            async ({ resourceId, documentId, audience }) =>
                guard(async () =>
                    text(await articleView(this.lk, await this.index(), resourceId, { audience, documentId })),
                ),
        );

        this.server.tool(
            "search",
            "LegendKeeper full-text search over article names, aliases and tab content, best match " +
                "first, with the matching passage. Searches as the DM: hits include hidden content.",
            {
                query: z.string().min(1).max(500),
                limit: z.number().int().min(1).max(100).default(20),
            },
            async ({ query, limit }) =>
                guard(async () => text(await searchView(this.lk, await this.index(), query, limit))),
        );

        this.server.tool(
            "find_by_tag",
            "Lists resources by tag, the way the charter's tag indexes do (DM Dashboard queries like " +
                "'npc' + 'act-1'; Field Notes indexes like 'met'). With audience \"player\", shows exactly " +
                "what a Field Notes index would show players right now. Templates never match.",
            {
                tags: z.array(z.string().min(1)).min(1),
                match: z.enum(["any", "all"]).default("all"),
                audience,
            },
            async ({ tags, match, audience }) =>
                guard(async () => text(taggedView(await this.index(), { tags, match, audience }))),
        );

        this.server.tool(
            "list_tags",
            "Every tag in the wiki with how many resources carry it and how many of those players " +
                "can see. Use to pick existing tag vocabulary and to audit charter §6 tagging discipline " +
                "(DM-only grouping tags should have 0 player-visible carriers).",
            {},
            async () => guard(async () => text(tagsView(await this.index()))),
        );

        this.server.tool(
            "get_page_blocks",
            "Raw block tree of one page tab as JSON, with block ids and the document version. For " +
                "debugging rendering and planning edits; prefer read_article for reading.",
            {
                resourceId: z.string(),
                documentId: z.string(),
            },
            async ({ resourceId, documentId }) =>
                guard(async () => json(await this.lk.getDocumentBlocks(resourceId, documentId))),
        );

        this.server.tool(
            "create_magic_item",
            "WRITES to the wiki: creates a new magic item article from the Consumable, Equipment or " +
                "Wondrous Item template, under Magic Items, hidden from players, and returns it as " +
                "read_article would. Campaign rule: a Common item shows its mechanics; from Uncommon up " +
                "they go in a secret block until the party identifies the item. So keep `description` to " +
                "what a character perceives, and put rules text in `mechanics`. Text fields are markdown: " +
                "paragraphs, `- ` lists, **bold**, *italic*, and mentions as [Name](lk:resourceId). " +
                "An optional `imageUrl` is downloaded into the project's asset library and shown beside " +
                "the description. Refuses a name an existing magic item already has. Where the item is found is not an " +
                "input: the article's Backlinks fill in when another article mentions it.",
            {
                name: z.string().trim().min(1).max(500),
                kind: z
                    .enum(Object.keys(ITEM_KINDS) as [ItemKind, ...ItemKind[]])
                    .describe("Which template: consumable (potions, drinks, one-use), equipment (worn or wielded: weapons, armor, rings), wondrous (everything else)."),
                rarity: z.enum(RARITIES),
                requiresAttunement: z.boolean().default(false),
                tags: z
                    .array(z.string().trim().min(1).max(100))
                    .default([])
                    .describe('Form tags beyond kind, rarity and attunement, which are added for you: e.g. "Ring", "Weapon", "Potion". Check list_tags for existing vocabulary.'),
                description: z.string().trim().min(1).describe("Player-facing: appearance, lore, and anything apparent without identifying the item."),
                mechanics: z.string().optional().describe("Rules text. Shown for Common items, secret otherwise."),
                curse: z.string().optional().describe("Always written to a secret block of its own, after the mechanics."),
                imageUrl: z
                    .string()
                    .url()
                    .regex(/^https?:\/\//, "must be an http(s) URL")
                    .optional()
                    .describe("A web image (JPEG, PNG, GIF or WebP, up to 10 MB) of the item. It is copied into LegendKeeper, not hotlinked. Omit it for an item with no artwork."),
                mechanicsRevealed: z
                    .boolean()
                    .optional()
                    .describe("Overrides the rarity rule: true writes mechanics as visible text, false as a secret."),
                parentId: z.string().optional().describe("Where to create it. Default: the Magic Items folder."),
            },
            async (input) =>
                guard(async () => {
                    const id = await createMagicItem(this.lk, await this.index(), input);
                    // The cached index predates the new article.
                    this.indexCache = undefined;
                    const article = await articleView(this.lk, await this.index(), id, { audience: "dm" });
                    return text(`Created. It is hidden from players until you reveal it.\n\n${article}`);
                }),
        );
    }

    /** The shared ResourceIndex, rebuilt after INDEX_TTL_MS or after a failed load. */
    private index(): Promise<ResourceIndex> {
        const now = Date.now();
        if (!this.indexCache || now - this.indexCache.loadedAt > INDEX_TTL_MS) {
            const index = ResourceIndex.load(this.lk);
            const entry = { loadedAt: now, index };
            index.catch(() => {
                if (this.indexCache === entry) this.indexCache = undefined;
            });
            this.indexCache = entry;
        }
        return this.indexCache.index;
    }
}

/**
 * Errors from the seam (a missing resource, an API failure) come back as
 * tool errors Claude can read and act on, not as protocol failures.
 */
async function guard(fn: () => Promise<ReturnType<typeof text>>) {
    try {
        return await fn();
    } catch (err) {
        return text(`Error: ${err instanceof Error ? err.message : String(err)}`, true);
    }
}

function text(body: string, isError = false) {
    return { content: [{ type: "text" as const, text: body }], isError };
}

function json(value: unknown) {
    return text(JSON.stringify(value, null, 2));
}

const oauthProvider = new OAuthProvider({
    apiHandlers: {
        // Streamable HTTP — what Claude's custom connectors speak.
        "/mcp": ConvergenceGambitMCP.serve("/mcp"),
        // Legacy SSE transport, kept for MCP Inspector compatibility.
        "/sse": ConvergenceGambitMCP.serveSSE("/sse"),
    },
    authorizeEndpoint: "/authorize",
    clientRegistrationEndpoint: "/register",
    defaultHandler: GitHubHandler,
    tokenEndpoint: "/token",
});

export default {
    fetch(request: Request, env: Env, ctx: ExecutionContext) {
        return oauthProvider.fetch(request, env, ctx);
    },

    scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
        ctx.waitUntil(runNightlyBackup(env));
    },
};
