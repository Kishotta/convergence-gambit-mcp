/**
 * In-memory fake LegendKeeper client.
 *
 * Seeded with a miniature slice of The Convergence Gambit so the walking
 * skeleton exercises the full Claude → MCP → client path with data that
 * looks like our real wiki. State lives only for the lifetime of the
 * Durable Object instance — that's fine; this is scaffolding, not storage.
 */

import type {
    CreateDocumentInput,
    CreateResourceInput,
    LegendKeeperClient,
    LKDocument,
    ProjectSnapshot,
    Resource,
    ResourceSummary,
    UpdateDocumentPatch,
    UpdateResourcePatch,
} from "./types";

let nextId = 100;
const id = (prefix: string) => `${prefix}_${nextId++}`;

interface Row {
    resource: Resource;
    documents: Map<string, LKDocument>;
}

export class FakeLegendKeeperClient implements LegendKeeperClient {
    private rows = new Map<string, Row>();

    constructor() {
        const sigil = this.seedResource({
            name: "Sigil",
            parentId: null,
            tags: ["geography", "act-1"],
        });
        this.seedResource(
            {
                name: "Bank of Abbathor",
                parentId: sigil.id,
                tags: ["shop", "lower-ward"],
            },
            "Gregory's promissory note is honored here — for a decreasing value each visit. " +
                "The tellers are unfailingly polite about it.",
        );
        this.seedResource(
            {
                name: "Morte",
                parentId: null,
                tags: ["npc", "party-companion"],
                aliases: ["the mimir"],
            },
            "A sentient mimir of dubious provenance and unshakable good cheer. " +
                'Comedically unbothered by the party\'s respawns: "the Planes are weird, chief."',
        );
        this.seedResource(
            {
                name: "Parisa",
                parentId: sigil.id,
                tags: ["npc", "hive-ward", "met"],
            },
            "Bariaur tout with a theatrical sign. The first warm face the party " +
                "meets after the Mortuary.",
        );
    }

    private seedResource(
        input: CreateResourceInput,
        overviewText?: string,
    ): Resource {
        const resourceId = id("res");
        const overview: LKDocument = {
            id: id("doc"),
            resourceId,
            type: "page",
            title: "Overview",
            infobox: true,
            content:
                overviewText ?? "Stub — awaiting migration from quarry file.",
        };
        const resource: Resource = {
            id: resourceId,
            name: input.name,
            parentId: input.parentId ?? null,
            tags: input.tags ?? [],
            aliases: input.aliases ?? [],
            secret: input.secret ?? false,
            documents: [overview],
        };
        this.rows.set(resourceId, {
            resource,
            documents: new Map([[overview.id, overview]]),
        });
        return resource;
    }

    private row(resourceId: string): Row {
        const row = this.rows.get(resourceId);
        if (!row) throw new Error(`Resource not found: ${resourceId}`);
        return row;
    }

    async listResources(): Promise<ResourceSummary[]> {
        return [...this.rows.values()].map(
            ({ resource: { documents, ...summary } }) => summary,
        );
    }

    async getResource(resourceId: string): Promise<Resource> {
        return this.row(resourceId).resource;
    }

    async createResource(input: CreateResourceInput): Promise<Resource> {
        return this.seedResource(input);
    }

    async updateResource(
        resourceId: string,
        patch: UpdateResourcePatch,
    ): Promise<Resource> {
        const row = this.row(resourceId);
        Object.assign(row.resource, patch);
        return row.resource;
    }

    async deleteResource(resourceId: string): Promise<void> {
        this.row(resourceId); // throw if missing
        this.rows.delete(resourceId);
    }

    async batchCreateResources(
        inputs: CreateResourceInput[],
    ): Promise<Resource[]> {
        return Promise.all(inputs.map((input) => this.createResource(input)));
    }

    async getDocument(
        resourceId: string,
        documentId: string,
    ): Promise<LKDocument> {
        const doc = this.row(resourceId).documents.get(documentId);
        if (!doc) throw new Error(`Document not found: ${documentId}`);
        return doc;
    }

    async createDocument(
        resourceId: string,
        input: CreateDocumentInput,
    ): Promise<LKDocument> {
        const row = this.row(resourceId);
        const doc: LKDocument = {
            id: id("doc"),
            resourceId,
            type: input.type,
            title: input.title,
            infobox: input.infobox,
            secret: input.secret ?? false,
            content: input.content ?? "",
        };
        row.documents.set(doc.id, doc);
        row.resource.documents.push(doc);
        return doc;
    }

    async updateDocument(
        resourceId: string,
        documentId: string,
        patch: UpdateDocumentPatch,
    ): Promise<LKDocument> {
        const doc = await this.getDocument(resourceId, documentId);
        Object.assign(doc, patch);
        return doc;
    }

    async exportProject(): Promise<ProjectSnapshot> {
        return {
            exportedAt: new Date().toISOString(),
            data: {
                resources: [...this.rows.values()].map((row) => row.resource),
            },
        };
    }
}
