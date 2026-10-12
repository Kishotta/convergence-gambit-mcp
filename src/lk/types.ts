/**
 * LegendKeeper domain types — The Convergence Gambit MCP server.
 *
 * The shapes come from the official v3 API (`@legendkeeper/sdk`, generated
 * from the OpenAPI spec, which ships in the package as openapi.json). They
 * are re-exported from here, type-only, so everything above the seam
 * imports LK types from this one file. When a beta release reshapes a
 * schema, the compiler points at the call sites and this file is where
 * any adapting alias goes.
 *
 * Resolved against the real spec (formerly SPEC-DRIFT):
 * 1. Visibility model: exposed. `isHidden` on resources (element), on
 *    documents (tab) and on properties; `secret` blocks for wiki-block
 *    secrecy. An admin-role key reads everything, hidden content included.
 *    Effective visibility (a hidden ancestor hides its descendants) is not
 *    precomputed by the API; see src/wiki/index.ts.
 * 2. Page content format: a typed block tree (`DocumentBlocks.blocks`),
 *    not ProseMirror JSON and not markdown. Runs carry marks, mentions or
 *    line breaks.
 * 3. Whole-project export: no such endpoint. src/backup.ts synthesizes a
 *    snapshot by walking the tree through this seam.
 */

import type { components } from "@legendkeeper/sdk";

type Schemas = components["schemas"];

export type ResourceListItem = Schemas["ResourceListItem"];
export type Resource = Schemas["Resource"];
export type LKDocument = Schemas["Document"];
export type DocumentType = LKDocument["type"];
export type DocumentBlocks = Schemas["DocumentBlocks"];
export type Block = Schemas["Block"];
export type Run = Schemas["Run"];
export type PropertyBlock = Schemas["PropertyBlock"];
export type SearchResult = Schemas["SearchResult"];
/** A map document's pin, label, region, path or folder. */
export type MapFeature = Schemas["Feature"];
export type TimelineLane = Schemas["Lane"];
export type TimelineEvent = Schemas["Event"];

/**
 * A mention's optional read-only `name` is the resource's current name; the
 * renderer prefers the author's `text` label and falls back to the index.
 */
export type Mention = Extract<Run, { mention: unknown }>["mention"];

/** The image formats the asset library stores. */
export const IMAGE_CONTENT_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"] as const;
export type ImageContentType = (typeof IMAGE_CONTENT_TYPES)[number];

/**
 * The virtual root of templates. A top-level template has this as its
 * `parentId`; a resource under a template is a template too. It is a
 * reserved id, not a resource: `getResource` never returns it.
 */
export const TEMPLATES_ROOT_ID = "templates";

// ---------------------------------------------------------------------------
// The client seam
// ---------------------------------------------------------------------------

/**
 * Everything above this interface (MCP tools, the wiki views in src/wiki/,
 * the nightly backup) talks only to `LegendKeeperClient`. The SDK-backed
 * client (src/lk/sdk.ts) implements it against the live project; the
 * in-memory fake (src/lk/fake.ts) implements it for local dev without an
 * API key.
 *
 * Mostly reads. Write methods are added one at a time, as a charter-aware
 * write tool needs them, rather than guessed ahead.
 */
export interface LegendKeeperClient {
    /** Which backend this is, so `ping` can say whether the data is real. */
    readonly backend: "legendkeeper" | "fake";

    /**
     * Every resource in the project (all pages), templates included, or only
     * direct children of `parentId` (`TEMPLATES_ROOT_ID` for the top-level templates).
     */
    listResources(options?: { parentId?: string }): Promise<ResourceListItem[]>;
    /** A resource with its documents (tabs) and sidebar properties. Throws on a miss. */
    getResource(resourceId: string): Promise<Resource>;
    /** A page document's content as a block tree. Throws on a miss. */
    getDocumentBlocks(resourceId: string, documentId: string): Promise<DocumentBlocks>;
    /** Full-text search over names, aliases and document content, best match first. */
    search(query: string, limit?: number): Promise<SearchResult[]>;
    /** Every feature of a map document, hidden ones included for an admin key. */
    listMapFeatures(resourceId: string, documentId: string): Promise<MapFeature[]>;
    /** A timeline document's lanes, including lanes of timelines it chains. */
    listTimelineLanes(resourceId: string, documentId: string): Promise<TimelineLane[]>;
    /** A timeline document's events (all pages), ordered by start. */
    listTimelineEvents(resourceId: string, documentId: string): Promise<TimelineEvent[]>;

    /**
     * A new resource copied from a template: its fields, sidebar properties
     * and documents with their content, under new ids. Throws if
     * `templateId` is not a template.
     */
    createFromTemplate(params: { templateId: string; name: string; parentId?: string }): Promise<Resource>;
    /** Changes only the fields given. */
    updateResource(resourceId: string, changes: { tags?: string[]; isHidden?: boolean }): Promise<Resource>;
    /**
     * Gives an id to every block of a page that lacks one. Pages written in
     * the app before block ids existed lack them, and a block needs an id
     * to be addressed or echoed.
     */
    assignBlockIds(resourceId: string, documentId: string): Promise<void>;
    /**
     * Stores an image in the project's asset library, in the root folder
     * named `folder` (created if missing) or at the root. An image block
     * accepts only the `url` this returns: a URL from anywhere else is
     * rejected on write.
     */
    uploadImage(params: {
        data: Uint8Array;
        contentType: ImageContentType;
        name: string;
        folder?: string;
    }): Promise<{ id: string; url: string }>;
    /**
     * Replaces a page's whole block tree. An `unsupported` block survives
     * only when echoed by id; leaving it out deletes content the API cannot
     * read. With `ifMatch` (a `DocumentBlocks.version`), throws if the page
     * changed since that read.
     */
    replaceDocumentBlocks(
        resourceId: string,
        documentId: string,
        blocks: Block[],
        ifMatch?: string,
    ): Promise<DocumentBlocks>;
}
