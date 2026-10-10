/**
 * In-memory fake LegendKeeper client.
 *
 * Answers when no LK_API_KEY is configured (local dev). Seeded with a
 * miniature slice of The Convergence Gambit in the real v3 shapes, and
 * deliberately exercising every layer of the visibility model: a hidden
 * element (Plots) with a non-hidden child, a hidden tab, a secret block,
 * a hidden sidebar property, and visible text that mentions a hidden
 * element (the charter's "one accepted leak"). Sigil's map and the campaign
 * timeline cover the same ground for pins and events: hidden ones, visible
 * ones linking to hidden articles, and a hidden map folder.
 */

import type {
    Block,
    DocumentBlocks,
    LegendKeeperClient,
    LKDocument,
    MapFeature,
    PropertyBlock,
    Resource,
    ResourceListItem,
    Run,
    SearchResult,
    TimelineEvent,
    TimelineLane,
} from "./types";

interface SeedTab {
    name: string;
    isHidden?: boolean;
    blocks?: Block[];
    /** Makes this a map tab. */
    features?: MapFeature[];
    /** Makes this a timeline tab. */
    timeline?: { lanes: TimelineLane[]; events: TimelineEvent[] };
}

interface SeedResource {
    id: string;
    name: string;
    parentId?: string;
    tags?: string[];
    aliases?: string[];
    isHidden?: boolean;
    properties?: PropertyBlock[];
    tabs: SeedTab[];
}

interface Row {
    resource: Resource;
    blocks: Map<string, DocumentBlocks>;
    features: Map<string, MapFeature[]>;
    timelines: Map<string, { lanes: TimelineLane[]; events: TimelineEvent[] }>;
}

const STAMP = "2026-10-01T00:00:00Z";

const t = (text: string): Run => ({ text });
const mention = (resourceId: string, text: string): Run => ({
    mention: { resourceId, text },
});
const p = (...content: Run[]): Block => ({ kind: "paragraph", content });
const h = (level: number, text: string): Block => ({
    kind: "heading",
    level,
    content: [t(text)],
});
const secret = (...children: Block[]): Block => ({ kind: "secret", children });

const pin = (id: string, name: string, extra: Partial<MapFeature> = {}): MapFeature => ({
    id,
    name,
    type: "pin",
    pos: [0, 0],
    rank: id,
    ...extra,
});
const sessionDate = (day: number) => ({
    year: 1491,
    month: 1,
    monthName: "Hammer",
    day,
    hour: 0,
    minute: 0,
    era: { id: "dr", name: "Dale Reckoning", abbr: "DR" },
});
const event = (id: string, day: number, name: string, extra: Partial<TimelineEvent> = {}): TimelineEvent => ({
    id,
    laneId: "lane0001",
    type: "event",
    start: day * 1440,
    startDate: sessionDate(day),
    formattedStart: `${day} Hammer 1491 DR`,
    name,
    ...extra,
});

const SEED: SeedResource[] = [
    {
        id: "sigil001",
        name: "Sigil",
        tags: ["geography"],
        aliases: ["the Cage", "City of Doors"],
        tabs: [
            {
                name: "Overview",
                blocks: [p(t("The City of Doors, perched on the inside of a ring atop an infinite spire."))],
            },
            {
                name: "Map",
                features: [
                    { id: "feat0001", name: "Hive Ward", type: "folder", rank: "a0" },
                    pin("feat0002", "Parisa's stand", { parentId: "feat0001", uri: "lk://resources/parisa01" }),
                    pin("feat0003", "Mortuary", { parentId: "feat0001", uri: "lk://resources/mortuary" }),
                    { id: "feat0004", name: "Lower Ward", type: "region", rank: "a1", polygon: [[0, 0], [1, 0], [1, 1]] },
                    pin("feat0005", "Bank of Abbathor", { parentId: "feat0004", uri: "lk://resources/bank0001" }),
                    // Not hidden itself, but links to a hidden article: LK auto-hides it.
                    pin("feat0006", "The Bazaar office", { uri: "lk://resources/shem0001" }),
                    pin("feat0007", "Unmarked door", { isHidden: true }),
                    { id: "feat0008", name: "DM markers", type: "folder", rank: "a2", isHidden: true },
                    pin("feat0009", "Ambush point", { parentId: "feat0008" }),
                ],
            },
        ],
    },
    {
        id: "bank0001",
        name: "Bank of Abbathor",
        parentId: "sigil001",
        tags: ["shop", "lower-ward"],
        tabs: [
            {
                name: "Overview",
                blocks: [
                    p(
                        t("Gregory's promissory note is honored here — for a decreasing value each visit. "),
                        t("The tellers are unfailingly polite about it."),
                    ),
                    secret(
                        p(
                            t("The vault's deepest ledger is kept for "),
                            mention("shem0001", "Shemeshka"),
                            t("."),
                        ),
                    ),
                ],
            },
        ],
    },
    {
        id: "morte001",
        name: "Morte",
        tags: ["npc", "party-companion", "met"],
        aliases: ["the mimir"],
        properties: [
            {
                id: "prop0001",
                kind: "keyValue",
                title: "Stats",
                rows: [{ key: "Species", text: "Mimir", content: [t("Mimir")] }],
            },
            {
                id: "prop0002",
                kind: "textField",
                title: "DM: true provenance",
                isHidden: true,
                children: [p(t("Not as dubious as he lets on."))],
            },
        ],
        tabs: [
            {
                name: "Overview",
                blocks: [
                    p(t("A sentient mimir of dubious provenance and unshakable good cheer.")),
                    p(t('Comedically unbothered by the party\'s respawns: "the Planes are weird, chief."')),
                ],
            },
            {
                name: "DM Notes",
                isHidden: true,
                blocks: [
                    h(2, "Wants"),
                    p(t("To stay useful enough that nobody asks where he came from.")),
                ],
            },
        ],
    },
    {
        id: "parisa01",
        name: "Parisa",
        parentId: "sigil001",
        tags: ["npc", "hive-ward", "met"],
        tabs: [
            {
                name: "Overview",
                blocks: [
                    p(
                        t("Bariaur tout with a theatrical sign. The first warm face the party meets after the "),
                        mention("mortuary", "Mortuary"),
                        t(". Rumored to owe money to "),
                        mention("shem0001", "Shemeshka"),
                        t("."),
                    ),
                ],
            },
        ],
    },
    {
        id: "mortuary",
        name: "Mortuary",
        parentId: "sigil001",
        tags: ["hive-ward", "dungeon"],
        tabs: [{ name: "Overview", blocks: [p(t("Where the party woke up."))] }],
    },
    {
        id: "campaign",
        name: "The Convergence Gambit",
        tabs: [
            { name: "Overview", blocks: [p(t("Campaign overview."))] },
            {
                name: "Campaign Timeline",
                timeline: {
                    lanes: [{ id: "lane0001", name: "Sessions", rank: "a0", size: "lg" }],
                    events: [
                        event("evt00001", 1, "Session 1: Grave Escape", { uri: "lk://resources/mortuary" }),
                        event("evt00002", 3, "Shemeshka takes notice", { uri: "lk://resources/shem0001", isHidden: true }),
                        event("evt00003", 4, "Session 2: A debt comes due", { uri: "lk://resources/shem0001" }),
                    ],
                },
            },
        ],
    },
    {
        id: "plots001",
        name: "Plots",
        isHidden: true,
        tabs: [{ name: "Overview", blocks: [p(t("Act containers and throughline subplots."))] }],
    },
    {
        id: "shem0001",
        name: "Shemeshka",
        parentId: "plots001",
        tags: ["npc", "shemeshka-network"],
        aliases: ["the Marauder"],
        tabs: [
            { name: "Overview", blocks: [p(t("Arcanaloth fixer. King of the Cross-Trade."))] },
            {
                name: "Endgame",
                isHidden: true,
                blocks: [secret(p(t("Crown-jewel secret — the Convergence.")))],
            },
        ],
    },
];

export class FakeLegendKeeperClient implements LegendKeeperClient {
    readonly backend = "fake";

    private rows = new Map<string, Row>();

    constructor() {
        SEED.forEach((seed, index) => this.seed(seed, index));
    }

    private seed(seed: SeedResource, index: number): void {
        const blocks = new Map<string, DocumentBlocks>();
        const features = new Map<string, MapFeature[]>();
        const timelines = new Map<string, { lanes: TimelineLane[]; events: TimelineEvent[] }>();
        const documents: LKDocument[] = seed.tabs.map((tab, tabIndex) => {
            const id = `${seed.id}d${tabIndex}`;
            let type: LKDocument["type"] = "page";
            if (tab.features) {
                type = "map";
                features.set(id, tab.features);
            } else if (tab.timeline) {
                type = "time";
                timelines.set(id, tab.timeline);
            } else {
                blocks.set(id, { id, version: "1", schema: 1, text: "", blocks: tab.blocks ?? [] });
            }
            return {
                id,
                name: tab.name,
                type,
                rank: `a${tabIndex}`,
                isHidden: tab.isHidden ?? false,
                createdAt: STAMP,
                updatedAt: STAMP,
            };
        });
        this.rows.set(seed.id, {
            resource: {
                id: seed.id,
                name: seed.name,
                parentId: seed.parentId,
                tags: seed.tags ?? [],
                aliases: seed.aliases ?? [],
                rank: `a${index}`,
                isHidden: seed.isHidden ?? false,
                permissions: {},
                documents,
                properties: seed.properties ?? [],
                createdAt: STAMP,
                updatedAt: STAMP,
            },
            blocks,
            features,
            timelines,
        });
    }

    private row(resourceId: string): Row {
        const row = this.rows.get(resourceId);
        if (!row) throw new Error(`Resource not found: ${resourceId}`);
        return row;
    }

    async listResources(options: { parentId?: string } = {}): Promise<ResourceListItem[]> {
        return [...this.rows.values()]
            .map(({ resource }) => resource)
            .filter((r) => options.parentId === undefined || r.parentId === options.parentId)
            .map((r) => ({
                id: r.id,
                name: r.name,
                parentId: r.parentId ?? null,
                tags: r.tags,
                aliases: r.aliases,
                rank: r.rank,
                isHidden: r.isHidden,
                documents: r.documents.map(({ id, name, type }) => ({ id, name, type })),
                createdAt: r.createdAt,
                updatedAt: r.updatedAt,
            }));
    }

    async getResource(resourceId: string): Promise<Resource> {
        return this.row(resourceId).resource;
    }

    async getDocumentBlocks(resourceId: string, documentId: string): Promise<DocumentBlocks> {
        const doc = this.row(resourceId).blocks.get(documentId);
        if (!doc) throw new Error(`Document not found: ${documentId}`);
        return doc;
    }

    async listMapFeatures(resourceId: string, documentId: string): Promise<MapFeature[]> {
        const features = this.row(resourceId).features.get(documentId);
        if (!features) throw new Error(`Map document not found: ${documentId}`);
        return features;
    }

    async listTimelineLanes(resourceId: string, documentId: string): Promise<TimelineLane[]> {
        return this.timeline(resourceId, documentId).lanes;
    }

    async listTimelineEvents(resourceId: string, documentId: string): Promise<TimelineEvent[]> {
        return this.timeline(resourceId, documentId).events;
    }

    private timeline(resourceId: string, documentId: string) {
        const timeline = this.row(resourceId).timelines.get(documentId);
        if (!timeline) throw new Error(`Timeline document not found: ${documentId}`);
        return timeline;
    }

    async search(query: string, limit = 32): Promise<SearchResult[]> {
        const needle = query.toLowerCase();
        if (!needle) return [];
        return [...this.rows.values()]
            .filter(({ resource }) =>
                [resource.name, ...resource.aliases].some((name) =>
                    name.toLowerCase().includes(needle),
                ),
            )
            .slice(0, limit)
            .map(({ resource }) => ({
                resource: {
                    id: resource.id,
                    name: resource.name,
                    parentId: resource.parentId ?? null,
                    tags: resource.tags,
                },
            }));
    }
}
