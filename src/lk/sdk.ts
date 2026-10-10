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
    DocumentBlocks,
    LegendKeeperClient,
    Resource,
    ResourceListItem,
    SearchResult,
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
