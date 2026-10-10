/**
 * LegendKeeper domain types — The Convergence Gambit MCP server.
 *
 * The shapes come from the official v3 API (`@legendkeeper/sdk`, generated
 * from the OpenAPI spec; a copy lives at docs/LegendKeeper API.json). They
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
 * Read-only for now. Write methods arrive with the charter-aware write
 * tools, designed against the real block model rather than guessed ahead.
 */
export interface LegendKeeperClient {
    /** Which backend this is, so `ping` can say whether the data is real. */
    readonly backend: "legendkeeper" | "fake";

    /** Every resource in the project (all pages), or only direct children of `parentId`. */
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
}
