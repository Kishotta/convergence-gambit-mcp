/**
 * LegendKeeperClient backed by the official `@legendkeeper/sdk`.
 *
 * The only file that imports the SDK at runtime. The SDK is a beta,
 * regenerated from the OpenAPI spec on every release, so it is pinned to an
 * exact version in package.json and confined here: a breaking release
 * should mean editing this file and src/lk/types.ts, not the tools.
 */

import { LegendKeeper, LegendKeeperError } from "@legendkeeper/sdk";

import type {
    Block,
    DocumentBlocks,
    ImageContentType,
    LegendKeeperClient,
    MapFeature,
    Resource,
    ResourceListItem,
    SearchResult,
    TimelineEvent,
    TimelineLane,
} from "./types";

/** The API's maximum page size for listResources. */
const PAGE_SIZE = 100;

export class SdkLegendKeeperClient implements LegendKeeperClient {
    readonly backend = "legendkeeper";

    private lk: LegendKeeper;

    /**
     * @param projectId Optional. Without it the SDK resolves the key's
     *   project with one extra request on first use.
     */
    constructor(
        apiKey: string,
        private projectId?: string,
    ) {
        this.lk = new LegendKeeper({
            apiKey,
            // The SDK calls `config.fetch(url, init)`, which on Workers
            // throws "Illegal invocation" for an unbound global fetch.
            fetch: (url, init) => fetch(url, init),
        });
    }

    async listResources(options: { parentId?: string } = {}): Promise<ResourceListItem[]> {
        return this.call(async () => {
            const items: ResourceListItem[] = [];
            const first = await this.lk.resources.list(
                { projectId: this.projectId },
                { limit: PAGE_SIZE, ...options },
            );
            for await (const item of first) items.push(item);
            return items;
        });
    }

    async getResource(resourceId: string): Promise<Resource> {
        return this.call(() =>
            this.lk.resources.get({ projectId: this.projectId, resourceId }),
        );
    }

    async getDocumentBlocks(resourceId: string, documentId: string): Promise<DocumentBlocks> {
        return this.call(() =>
            this.lk.documents.getBlocks({
                projectId: this.projectId,
                resourceId,
                documentId,
            }),
        );
    }

    async search(query: string, limit?: number): Promise<SearchResult[]> {
        return this.call(async () => {
            const page = await this.lk.search.search(
                { projectId: this.projectId },
                { q: query, limit },
            );
            return page.data;
        });
    }

    async listMapFeatures(resourceId: string, documentId: string): Promise<MapFeature[]> {
        return this.call(async () => {
            const page = await this.lk.features.list({
                projectId: this.projectId,
                resourceId,
                documentId,
            });
            return page.data;
        });
    }

    async listTimelineLanes(resourceId: string, documentId: string): Promise<TimelineLane[]> {
        return this.call(async () => {
            const page = await this.lk.timelines.listLanes({
                projectId: this.projectId,
                resourceId,
                documentId,
            });
            return page.data;
        });
    }

    async listTimelineEvents(resourceId: string, documentId: string): Promise<TimelineEvent[]> {
        return this.call(async () => {
            const events: TimelineEvent[] = [];
            const first = await this.lk.timelines.listEvents(
                { projectId: this.projectId, resourceId, documentId },
                { limit: PAGE_SIZE },
            );
            for await (const event of first) events.push(event);
            return events;
        });
    }

    async createFromTemplate(params: {
        templateId: string;
        name: string;
        parentId?: string;
    }): Promise<Resource> {
        return this.call(() =>
            this.lk.resources.createFromTemplate({ projectId: this.projectId }, params),
        );
    }

    async updateResource(
        resourceId: string,
        changes: { tags?: string[]; isHidden?: boolean },
    ): Promise<Resource> {
        return this.call(() =>
            this.lk.resources.update({ projectId: this.projectId, resourceId }, changes),
        );
    }

    async assignBlockIds(resourceId: string, documentId: string): Promise<void> {
        await this.call(() =>
            this.lk.documents.assignBlockIds({ projectId: this.projectId, resourceId, documentId }),
        );
    }

    async uploadImage(params: {
        data: Uint8Array;
        contentType: ImageContentType;
        name: string;
        folder?: string;
    }): Promise<{ id: string; url: string }> {
        return this.call(async () => {
            const { folder, ...image } = params;
            const folderId = folder ? await this.assetFolder(folder) : undefined;
            const asset = await this.lk.assets.uploadImage({ ...image, folderId, projectId: this.projectId });
            if (!asset.url) throw new Error(`Uploaded image ${asset.id} came back without a url`);
            return { id: asset.id, url: asset.url };
        });
    }

    /** The id of the root asset folder with this name, created if there is none. */
    private async assetFolder(name: string): Promise<string> {
        const root = await this.lk.assets.list({ projectId: this.projectId }, { limit: PAGE_SIZE });
        for await (const asset of root) {
            if (asset.type === "FOLDER" && asset.name === name) return asset.id;
        }
        const created = await this.lk.assets.createFolder({ projectId: this.projectId }, { name });
        return created.id;
    }

    async replaceDocumentBlocks(
        resourceId: string,
        documentId: string,
        blocks: Block[],
        ifMatch?: string,
    ): Promise<DocumentBlocks> {
        return this.call(() =>
            this.lk.documents.replaceBlocks(
                { projectId: this.projectId, resourceId, documentId },
                { blocks, ifMatch },
            ),
        );
    }

    /**
     * Rethrows SDK errors with the API's code and request id in the
     * message, which tools surface verbatim as tool errors. The request id
     * is what to quote when reporting an API problem upstream.
     */
    private async call<T>(fn: () => Promise<T>): Promise<T> {
        try {
            return await fn();
        } catch (err) {
            if (err instanceof LegendKeeperError) {
                const issues = (err.errors ?? [])
                    .map((issue) => ` ${issue.path}: ${issue.message}`)
                    .join(";");
                throw new Error(
                    `LegendKeeper ${err.status} ${err.code ?? "ERROR"}: ${err.message}` +
                        (issues ? ` —${issues}` : "") +
                        (err.requestId ? ` (request ${err.requestId})` : ""),
                );
            }
            throw err;
        }
    }
}
