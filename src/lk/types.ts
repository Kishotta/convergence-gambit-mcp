/**
 * LegendKeeper domain types — The Convergence Gambit MCP server.
 *
 * Derived from the pre-release API docs screenshot (v2). Field names and
 * shapes are BEST GUESSES until the real docs land. Every speculative
 * field is tagged with `SPEC-DRIFT` so we can grep for them during the
 * post-release reconciliation pass.
 *
 * Known from the screenshot:
 * - A Resource is the core wiki-article entity. Resources form a tree via
 *   `parentId` and carry tags, aliases, icons, and banners.
 * - Each Resource contains one or more Documents (content tabs): pages
 *   (rich text), maps (pins & regions), boards (drawings), or timelines
 *   (events & lanes). Documents have an optional `infobox` setting.
 * - Resources can have Properties (structured sidebar data).
 * - Endpoints: GET/POST /api/v2/projects/{projectId}/resources,
 *   GET/PATCH/DELETE .../resources/{resourceId},
 *   POST .../resources/batch, plus nested Document operations.
 */

export type DocumentType = "page" | "map" | "board" | "timeline";

export interface ResourceSummary {
    id: string;
    name: string;
    parentId: string | null;
    tags: string[];
    aliases: string[];
    /** SPEC-DRIFT: icon/banner shape unknown — could be asset IDs or URLs. */
    icon?: string;
    banner?: string;
    /**
     * SPEC-DRIFT (CRITICAL UNKNOWN #1): does the API expose the visibility
     * model? Our entire architecture charter depends on element/tab/block
     * secrecy. If this field doesn't exist in the real API, article creation
     * requires a manual secrecy pass in the UI and our tooling must say so
     * loudly rather than silently publishing spoilers.
     */
    secret?: boolean;
}

export interface Resource extends ResourceSummary {
    documents: DocumentSummary[];
    properties?: PropertyValue[];
}

export interface DocumentSummary {
    id: string;
    resourceId: string;
    type: DocumentType;
    title: string;
    /** Enables the inline property panel (confirmed in screenshot). */
    infobox?: boolean;
    /** SPEC-DRIFT: tab-level secrecy — same critical unknown as Resource.secret. */
    secret?: boolean;
}

export interface LKDocument extends DocumentSummary {
    /**
     * SPEC-DRIFT (CRITICAL UNKNOWN #2): content format for `page` documents.
     * Almost certainly a structured rich-text tree (ProseMirror-style JSON),
     * not markdown. Until confirmed, we treat it as opaque `unknown` and the
     * markdown→LK converter is a separate module that targets whatever this
     * turns out to be.
     */
    content: unknown;
}

/** SPEC-DRIFT: property shape guessed from "structured sidebar data". */
export interface PropertyValue {
    key: string;
    value: string | number | boolean | null;
}

// ---------------------------------------------------------------------------
// Write inputs
// ---------------------------------------------------------------------------

export interface CreateResourceInput {
    name: string;
    parentId?: string | null;
    tags?: string[];
    aliases?: string[];
    secret?: boolean; // SPEC-DRIFT — see above.
}

export type UpdateResourcePatch = Partial<CreateResourceInput>;

export interface CreateDocumentInput {
    type: DocumentType;
    title: string;
    content?: unknown;
    infobox?: boolean;
    secret?: boolean; // SPEC-DRIFT — see above.
}

export type UpdateDocumentPatch = Partial<CreateDocumentInput>;

// ---------------------------------------------------------------------------
// The client seam
// ---------------------------------------------------------------------------

/**
 * Everything above this interface (MCP tools, charter-aware conveniences)
 * talks only to `LegendKeeperClient`. The in-memory fake implements it
 * today; the real HTTP client implements it the day the API ships. Nothing
 * above the seam changes at cutover.
 */
export interface LegendKeeperClient {
    listResources(): Promise<ResourceSummary[]>;
    getResource(resourceId: string): Promise<Resource>;
    createResource(input: CreateResourceInput): Promise<Resource>;
    updateResource(
        resourceId: string,
        patch: UpdateResourcePatch,
    ): Promise<Resource>;
    deleteResource(resourceId: string): Promise<void>;
    batchCreateResources(inputs: CreateResourceInput[]): Promise<Resource[]>;

    getDocument(resourceId: string, documentId: string): Promise<LKDocument>;
    createDocument(
        resourceId: string,
        input: CreateDocumentInput,
    ): Promise<LKDocument>;
    updateDocument(
        resourceId: string,
        documentId: string,
        patch: UpdateDocumentPatch,
    ): Promise<LKDocument>;
}
