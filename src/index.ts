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
 * Write-side toolset, one charter-aware tool per kind of article, plus a
 * catch-all for the articles that already exist:
 *   - create_magic_item  a new, hidden item from the Magic Item templates
 *   - create_spell, create_class, create_subclass, create_feat,
 *     create_background, create_species
 *                        player options in the 5.5e rules branch, visible
 *                        unless asked otherwise (src/wiki/spells.ts,
 *                        classes.ts, feats.ts and origins.ts)
 *   - edit_page          insert, replace and delete blocks of a page tab
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
import { editPage } from "./wiki/edit";
import { createMagicItem, ITEM_KINDS, RARITIES, type ItemKind } from "./wiki/items";
import { CASTERS, createClass, createSubclass, type Caster } from "./wiki/classes";
import type { Created } from "./wiki/create";
import { createFeat, FEAT_CATEGORIES, type FeatCategory } from "./wiki/feats";
import { createBackground, createSpecies } from "./wiki/origins";
import { createSpell, SCHOOLS } from "./wiki/spells";
import { articleView, searchView, taggedView, tagsView, templatesView, treeView } from "./wiki/views";

/**
 * How long a ResourceIndex snapshot is reused. Long enough that a burst of
 * tool calls shares one tree walk; short enough that a reveal Connor just
 * made in the app shows up within a minute.
 */
const INDEX_TTL_MS = 60_000;

/** What every player-option tool says about its markdown fields. */
const OPTION_MARKDOWN =
    "Text fields are markdown: paragraphs, headings (#### for a feature or trait heading, ##### below it), " +
    "`- ` and `1. ` lists, `> ` quotes, pipe tables (| a | b |, with a | --- | line under the header), " +
    "**bold**, *italic* (_**Name.**_ for the bold-italic run-in labels rules text uses), links, and mentions " +
    "of other articles as [Name](lk:resourceId) (find ids with search or get_tree). ";

/** The parameters every player-option tool shares. */
const playerOption = {
    tags: z
        .array(z.string().trim().min(1).max(100))
        .default([])
        .describe("Extra tags beyond the ones the tool sets. Check list_tags for existing vocabulary."),
    hidden: z
        .boolean()
        .default(false)
        .describe(
            "Player options are created visible, since they are for players to read. true creates it hidden " +
                "(homebrew still under review, or an option that is itself a spoiler).",
        ),
};
const optionSource = z
    .string()
    .trim()
    .min(1)
    .max(100)
    .describe(
        'Where it comes from, as a tag: "WotC" for official books, the book\'s name for third-party ' +
            '("Valda\'s Spire of Secrets"), "Homebrew" for the campaign\'s own.',
    );
const optionImage = z
    .string()
    .url()
    .regex(/^https?:\/\//, "must be an http(s) URL")
    .optional()
    .describe("A web image (JPEG, PNG, GIF or WebP, up to 10 MB). It is copied into LegendKeeper, not hotlinked.");
const optionParent = z.string().optional().describe("Where to create it, if not its usual 5.5e folder.");
const casterParam = z
    .enum(Object.keys(CASTERS) as [Caster, ...Caster[]])
    .default("none")
    .describe(
        'Spellcasting progression, tagged "Spellcaster" plus "Full Caster", "Half Caster", "Third Caster" or "Pact Caster".',
    );

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
                blockIds: z
                    .boolean()
                    .default(false)
                    .describe(
                        "Before edit_page: print each page block's id on a ⟦id⟧ line above it, and each page " +
                            "tab's document version. A page written before block ids existed is given them " +
                            "(no content changes).",
                    ),
            },
            async ({ resourceId, documentId, audience, blockIds }) =>
                guard(async () =>
                    text(
                        await articleView(this.lk, await this.index(), resourceId, { audience, documentId, blockIds }),
                    ),
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
                "paragraphs, `- ` lists, `> ` quote blocks, **bold**, *italic*, and mentions as [Name](lk:resourceId). " +
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

        this.server.tool(
            "create_spell",
            "WRITES to the wiki: creates a spell article in 5.5e / Spells from the Spell template, with its stats " +
                "in the template's infobox, and returns it as read_article would. Tags are set for you: Spell, its " +
                "components, school, classes, Ritual and Concentration. The class tags are what put the spell on " +
                "each class's Spell List tab, so list every class that can learn it. Feed it the spell as the " +
                "source prints it: the stat block into the fields, the rest into `description`. " +
                OPTION_MARKDOWN +
                "Refuses a name an existing spell already has.",
            {
                name: z.string().trim().min(1).max(500),
                level: z.number().int().min(0).max(9).describe("0 for a cantrip."),
                school: z.enum(SCHOOLS),
                classes: z
                    .array(z.string().trim().min(1).max(100))
                    .default([])
                    .describe('Class names whose spell list it is on, e.g. ["Cleric", "Wizard"].'),
                castingTime: z
                    .string()
                    .trim()
                    .min(1)
                    .describe('e.g. "Action", "Bonus Action", "1 Minute", "Reaction, which you take when …".'),
                range: z.string().trim().min(1).describe('Range or area, e.g. "60 feet", "Self (15-foot Cone)", "Touch".'),
                duration: z
                    .string()
                    .trim()
                    .min(1)
                    .describe('As printed, e.g. "Instantaneous", "Concentration, up to 1 minute".'),
                verbal: z.boolean(),
                somatic: z.boolean(),
                material: z
                    .string()
                    .trim()
                    .optional()
                    .describe("The material component's text, if it has one: tags it Material and fills Material Components."),
                damageEffect: z
                    .string()
                    .optional()
                    .describe('The infobox\'s Damage/Effect, e.g. "2d8 Radiant", "Healing", "Control".'),
                attackSave: z.string().optional().describe('e.g. "None", "Ranged", "Melee", "DEX Save".'),
                ritual: z.boolean().default(false),
                concentration: z.boolean().default(false),
                description: z.string().trim().min(1).describe("The spell's effect text."),
                higherLevels: z
                    .string()
                    .optional()
                    .describe('The "Using a Higher-Level Spell Slot" or cantrip-upgrade text, without its label.'),
                source: optionSource.optional(),
                ...playerOption,
                parentId: optionParent,
            },
            async (input) => guard(async () => this.created(await createSpell(this.lk, await this.index(), input))),
        );

        this.server.tool(
            "create_class",
            "WRITES to the wiki: creates a class article in 5.5e / Classes and returns it as read_article would. " +
                "Shape: the class image and core traits in an infobox floated right, the intro, then " +
                '"### <Class> Class Features" with the features table and every feature. A spellcaster also gets a ' +
                "Spell List tab gathering every spell tagged with the class (create_spell's `classes`). Tags: Class, " +
                "the class's name, source, and caster progression. Add subclasses afterwards with create_subclass. " +
                OPTION_MARKDOWN +
                "Refuses a name an existing class already has.",
            {
                name: z.string().trim().min(1).max(500),
                source: optionSource,
                primaryAbility: z.string().trim().min(1),
                hitPointDie: z.string().trim().min(1).describe('e.g. "D10 per Fighter level".'),
                savingThrows: z.string().trim().min(1).describe('e.g. "Strength and Constitution".'),
                skillProficiencies: z.string().trim().min(1).describe('e.g. "Choose 2: Acrobatics, Athletics, …".'),
                weaponProficiencies: z.string().trim().min(1),
                toolProficiencies: z.string().optional(),
                armorTraining: z.string().trim().min(1).describe('e.g. "Light and Medium armor and Shields", or "None".'),
                startingEquipment: z.string().trim().min(1).describe('e.g. "Choose A or B: (A) …; or (B) 75 GP".'),
                caster: casterParam,
                spellList: z.boolean().optional().describe("Add the Spell List tab. Default: yes for a spellcaster."),
                description: z.string().trim().min(1).describe("The class's introduction, before its features."),
                featuresTable: z
                    .string()
                    .trim()
                    .min(1)
                    .describe("The class features table as a pipe table: | Level | PB | Class Features | … |, a row per level."),
                features: z
                    .string()
                    .trim()
                    .min(1)
                    .describe(
                        'Every feature, each as "#### Level N: Feature Name" and its text, in level order. Option lists ' +
                            "(invocations, formulae) can follow under their own #### headings.",
                    ),
                imageUrl: optionImage,
                ...playerOption,
                parentId: optionParent,
            },
            async (input) => guard(async () => this.created(await createClass(this.lk, await this.index(), input))),
        );

        this.server.tool(
            "create_subclass",
            "WRITES to the wiki: creates a subclass article nested under its class article (which must exist; see " +
                "create_class) and returns it as read_article would. Shape: an italic tagline quote, the image, the " +
                "intro, then its features. Tags: Subclass, the class's name, source, and caster progression when the " +
                "subclass itself grants spellcasting (a third caster such as Eldritch Knight). " +
                OPTION_MARKDOWN +
                "Refuses a name the class already has a subclass by.",
            {
                name: z.string().trim().min(1).max(500),
                parentClass: z.string().trim().min(1).describe('The class\'s name (e.g. "Warlock") or its resource id.'),
                source: optionSource,
                caster: casterParam,
                tagline: z
                    .string()
                    .optional()
                    .describe('The one-line flavor heading, e.g. "Unearth Forbidden Lore of Ineffable Beings".'),
                description: z.string().trim().min(1).describe("The subclass's introduction."),
                features: z
                    .string()
                    .trim()
                    .min(1)
                    .describe(
                        'Every feature, each as "#### Level N: Feature Name" and its text. Always-prepared spells as a pipe table.',
                    ),
                imageUrl: optionImage,
                ...playerOption,
            },
            async (input) => guard(async () => this.created(await createSubclass(this.lk, await this.index(), input))),
        );

        this.server.tool(
            "create_feat",
            "WRITES to the wiki: creates a feat article in 5.5e / Feats and returns it as read_article would. It " +
                "opens with its category and prerequisite in italics, then the benefit text. Tags: Feat, " +
                '"<Category> Feat" (e.g. Origin Feat), source, and Repeatable. Create an Origin feat before a ' +
                "background that grants it, so the background can link it. " +
                OPTION_MARKDOWN +
                "Refuses a name an existing feat already has.",
            {
                name: z.string().trim().min(1).max(500),
                category: z.enum(Object.keys(FEAT_CATEGORIES) as [FeatCategory, ...FeatCategory[]]),
                prerequisite: z
                    .string()
                    .optional()
                    .describe('As printed, without "Prerequisite:", e.g. "Level 4+, Strength or Dexterity 13+".'),
                repeatable: z.boolean().default(false),
                description: z
                    .string()
                    .trim()
                    .min(1)
                    .describe("The feat's benefits, e.g. a paragraph per benefit with a _**Name.**_ run-in label."),
                source: optionSource.optional(),
                imageUrl: optionImage,
                ...playerOption,
                parentId: optionParent,
            },
            async (input) => guard(async () => this.created(await createFeat(this.lk, await this.index(), input))),
        );

        this.server.tool(
            "create_background",
            "WRITES to the wiki: creates a background article in 5.5e / Backgrounds from the Background template, " +
                "filling its Ability Scores, Skill Proficiencies, Feat, Tool Proficiency and Equipment fields, and " +
                "returns it as read_article would. The Feat field links the feat's article when one has that name " +
                "(create it first with create_feat). Tags: Background and source. " +
                OPTION_MARKDOWN +
                "Refuses a name an existing background already has.",
            {
                name: z.string().trim().min(1).max(500),
                source: optionSource,
                description: z.string().trim().min(1).describe("The background's flavor text."),
                details: z
                    .string()
                    .optional()
                    .describe('Anything more, after the description: a feature ("#### Conviction" and its text), a table.'),
                abilityScores: z
                    .string()
                    .trim()
                    .min(1)
                    .describe('The three abilities, e.g. "Constitution, Intelligence, Charisma".'),
                skillProficiencies: z.string().trim().min(1),
                feat: z.string().trim().min(1).describe('The Origin feat, e.g. "Alert" or "Magic Initiate (Cleric)".'),
                toolProficiency: z.string().optional(),
                equipment: z
                    .string()
                    .trim()
                    .min(1)
                    .describe('A `- ` list, e.g. "- Choose A or B: (A) …; or (B) 50 GP".'),
                imageUrl: optionImage,
                ...playerOption,
                parentId: optionParent,
            },
            async (input) => guard(async () => this.created(await createBackground(this.lk, await this.index(), input))),
        );

        this.server.tool(
            "create_species",
            "WRITES to the wiki: creates a species article in 5.5e / Species from the Species template, with Type, " +
                "Size and Speed in its fields and each trait as its own section, and returns it as read_article would. " +
                "Tags: Species, the species' name, source and creature type. " +
                OPTION_MARKDOWN +
                "Refuses a name an existing species already has.",
            {
                name: z.string().trim().min(1).max(500),
                source: optionSource,
                description: z.string().trim().min(1).describe("The species' flavor text."),
                creatureType: z.string().trim().min(1).default("Humanoid"),
                size: z.string().trim().min(1).describe('e.g. "Medium (about 4–7 feet tall)" or "Small or Medium".'),
                speed: z.string().trim().min(1).describe('e.g. "30 feet".'),
                traits: z
                    .array(
                        z.object({
                            name: z.string().trim().min(1).max(200),
                            description: z.string().trim().min(1),
                        }),
                    )
                    .min(1),
                imageUrl: optionImage,
                ...playerOption,
                parentId: optionParent,
            },
            async (input) => guard(async () => this.created(await createSpecies(this.lk, await this.index(), input))),
        );

        const blockId = z.string().min(1).max(256);
        const markdown = z.string().min(1).describe("Markdown, written as read_article prints page text.");
        this.server.tool(
            "edit_page",
            "WRITES to the wiki: inserts, replaces and deletes blocks in one page tab of an existing " +
                "article, to bring it in line with newer notes. First call read_article with blockIds for " +
                "that tab: it gives the document version and a ⟦id⟧ line above each block. Operations apply " +
                "in order and stop at the first failure; mistakes in the request are caught before anything " +
                "is written. Returns what each operation did, the old text of anything replaced or deleted, " +
                "and the tab as it now stands with its new version and ids. " +
                "Markdown: paragraphs, headings (### is the page's top level, #### the next), `- ` and `1. ` " +
                "lists, `> ` quotes (a first line of **Note:**, **Info:**, **Warning:**, **Success:** or " +
                "**Error:** makes a callout), `---`, **bold**, *italic*, ~~strike~~, `code`, links, and " +
                "mentions as [Name](lk:resourceId), and pipe tables (| a | b |, with a | --- | line under the " +
                "header row). One markdown may hold several blocks. A list or table has one id: change an " +
                "item or a cell by replacing the whole list or table. Images and infoboxes can be deleted " +
                "or left alone, not written. " +
                "SECRECY is never read from the text. An insert is secret when placed in or beside the " +
                "contents of a secret block (give the secret block's id as `parent`), or when `secret` is " +
                "true, which wraps it in a new secret block; otherwise players can read it. A replace " +
                "keeps what the block was: replacing a secret block rewrites its contents and it stays " +
                "secret. Never paste a rendered secret block or ⟦id⟧ lines back as markdown.",
            {
                resourceId: z.string().describe("The article."),
                documentId: z.string().describe("The page tab, from the article's tab headings."),
                version: z.string().describe("The tab's document version from read_article with blockIds."),
                operations: z
                    .array(
                        z.discriminatedUnion("op", [
                            z.object({
                                op: z.literal("insert"),
                                markdown,
                                after: blockId.optional().describe("Insert after this block."),
                                before: blockId.optional().describe("Insert before this block."),
                                parent: blockId
                                    .optional()
                                    .describe(
                                        "Append as the last child of this container (a secret block, quote, callout, " +
                                            "collapsible or layout column). With none of the three: the end of the page.",
                                    ),
                                secret: z.boolean().optional().describe("true: wrap in a new secret block."),
                            }),
                            z.object({
                                op: z.literal("replace"),
                                blockId,
                                markdown,
                                secret: z
                                    .boolean()
                                    .optional()
                                    .describe(
                                        "Omit to keep the block's secrecy. true: a visible block becomes a secret " +
                                            "block. false: a secret block becomes player-facing text (a reveal).",
                                    ),
                            }),
                            z.object({
                                op: z.literal("delete"),
                                blockId: blockId.describe("Removed with everything inside it."),
                            }),
                        ]),
                    )
                    .min(1)
                    .max(50),
            },
            async ({ resourceId, documentId, version, operations }) =>
                guard(async () => {
                    const index = await this.index();
                    const report = await editPage(this.lk, index, { resourceId, documentId, version, operations });
                    const article = await articleView(this.lk, index, resourceId, {
                        audience: "dm",
                        documentId,
                        blockIds: true,
                    });
                    return text(`${report}\n\n---\n\n${article}`);
                }),
        );
    }

    /** A create tool's answer: anything to know about how it went, then the new article. */
    private async created({ id, notes }: Created) {
        // The cached index predates the new article.
        this.indexCache = undefined;
        const index = await this.index();
        const article = await articleView(this.lk, index, id, { audience: "dm" });
        const visibility = index.isPlayerVisible(id) ? "Players can see it now." : "It is hidden from players.";
        const list = notes.length ? `\n\nNotes:\n${notes.map((note) => `- ${note}`).join("\n")}` : "";
        return text(`Created. ${visibility}${list}\n\n${article}`);
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
