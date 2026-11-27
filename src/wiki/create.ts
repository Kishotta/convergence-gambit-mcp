/**
 * What the create_* write views share: finding their template and home
 * folder, refusing a duplicate, storing an image, filling a template copy
 * by field title, and the two ways an article comes to exist.
 *
 * - From a template (`createFilledCopy`): the copy keeps what the API can't
 *   write, such as the sidebar Tags display, and the template's fields are
 *   filled by title. The copy and its filling are separate requests, so a
 *   failure partway leaves a bare copy, and the error says so.
 * - From scratch (`createWhole`), for a kind with no template: the article,
 *   its tags and every tab's content go in one request, so it either exists
 *   complete or not at all.
 *
 * An image block accepts only an asset of this project, so an image given
 * as a web URL is downloaded first (before anything is created, so a bad
 * link leaves nothing behind) and stored in the asset library.
 */

import {
    IMAGE_CONTENT_TYPES,
    TEMPLATES_ROOT_ID,
    type Block,
    type ImageContentType,
    type LegendKeeperClient,
    type PropertyBlock,
    type ResourceListItem,
} from "../lk/types";
import { composeRuns } from "./compose";
import type { ResourceIndex } from "./index";

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/** The root folder the rules reference lives in; player options are homed under it by kind. */
export const RULES_ROOT = "5.5e";

/** A created article, and anything the caller should hear about how it went. */
export interface Created {
    id: string;
    notes: string[];
}

export interface FetchedImage {
    data: Uint8Array;
    contentType: ImageContentType;
}

export interface StoredImage {
    url: string;
    alt: string;
}

export async function fetchImage(url: string): Promise<FetchedImage> {
    const fail = (why: string) => new Error(`Image ${url} ${why}. Nothing was created.`);
    let response: Response;
    try {
        response = await fetch(url);
    } catch (err) {
        throw fail(`could not be fetched (${err instanceof Error ? err.message : String(err)})`);
    }
    if (!response.ok) throw fail(`answered ${response.status}`);

    const type = (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    const contentType = IMAGE_CONTENT_TYPES.find((known) => known === (type === "image/jpg" ? "image/jpeg" : type));
    if (!contentType) throw fail(`is ${type || "of no declared type"}, not a JPEG, PNG, GIF or WebP image`);

    const data = new Uint8Array(await response.arrayBuffer());
    if (!data.byteLength) throw fail("is empty");
    if (data.byteLength > MAX_IMAGE_BYTES) throw fail(`is ${Math.round(data.byteLength / 1024 / 1024)} MB, over the 10 MB limit`);
    return { data, contentType };
}

/** Trimmed, in order, without case-insensitive repeats or blanks. */
export function uniqueTags(tags: (string | undefined | false)[]): string[] {
    const seen = new Set<string>();
    return tags
        .map((tag) => (tag || "").trim())
        .filter((tag) => tag && !seen.has(tag.toLowerCase()) && seen.add(tag.toLowerCase()));
}

/** A top-level template, by name, so a recreated template still resolves. */
export function findTemplate(index: ResourceIndex, name: string): ResourceListItem {
    const template = index.children(TEMPLATES_ROOT_ID).find((t) => t.name === name);
    if (!template) throw new Error(`Template "${name}" not found (see list_templates). Nothing was created.`);
    return template;
}

/**
 * Where a new article goes: `parentId` when given, else the folder named
 * `folder` under the 5.5e rules root.
 */
export function findHome(index: ResourceIndex, folder: string, parentId?: string): ResourceListItem {
    if (parentId) {
        const parent = index.get(parentId);
        if (!parent) throw new Error(`Parent not found: ${parentId}. Nothing was created.`);
        if (index.isTemplate(parentId)) throw new Error(`${parent.name} is a template, not an article. Nothing was created.`);
        return parent;
    }
    const root = index.children(null).find((r) => r.name === RULES_ROOT);
    const home = root && index.children(root.id).find((r) => r.name === folder);
    if (!home) throw new Error(`The "${RULES_ROOT} / ${folder}" folder was not found. Nothing was created.`);
    return home;
}

/**
 * Refuses a name already taken by an article of the same kind: anything
 * under `home`, or anywhere carrying `tag`.
 */
export function refuseTwin(index: ResourceIndex, kind: string, name: string, home: ResourceListItem, tag?: string): void {
    const wanted = name.trim().toLowerCase();
    const candidates = [...index.inTreeOrder(home.id), ...(tag ? index.withTags([tag], "all") : [])];
    const twin = candidates.find((r) => r.name.trim().toLowerCase() === wanted);
    if (twin) {
        throw new Error(
            `A ${kind} named "${twin.name}" already exists (${twin.id}, in ${index.pathLabel(twin.id)}). ` +
                "Nothing was created; use edit_page to change it.",
        );
    }
}

/** The article of this kind whose name matches, ignoring case, if any. */
export function findByName(candidates: ResourceListItem[], name: string): ResourceListItem | undefined {
    const wanted = name.trim().toLowerCase();
    return candidates.find((r) => r.name.trim().toLowerCase() === wanted);
}

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

/** One line of inline markdown as a paragraph. */
export function line(markdown: string): Block {
    return { kind: "paragraph", content: markdown.trim() ? composeRuns(markdown.trim()) : [] };
}

/** A titled text field, the box the 5.5e articles show a stat in. */
export function textField(title: string, children: Block[]): Block {
    return { kind: "textField", title, isTitleHidden: false, children };
}

export function heading(level: number, markdown: string): Block {
    return { kind: "heading", level, content: composeRuns(markdown) };
}

/** The plain text of a paragraph or heading. */
function plainText(block: Block): string {
    if (block.kind !== "paragraph" && block.kind !== "heading") return "";
    return block.content.map((run) => ("text" in run ? run.text : "")).join("").trim();
}

// ---------------------------------------------------------------------------
// Filling a template copy
// ---------------------------------------------------------------------------

export interface TemplateFill {
    /**
     * Field contents by text-field title, matched ignoring case: in the page,
     * in its layouts, or as infobox rows. `null` removes the field. A field
     * the template lacks is added after everything else, and reported.
     */
    fields: Record<string, Block[] | null>;
    /** Titles in `fields` the template needn't have: added at the end without a note when missing. */
    optional?: string[];
    /** Replaces the template's "Description" placeholder paragraph. */
    description: Block[];
    /** Fills the template's empty image slot; without one the slot is removed. */
    image?: StoredImage;
    /** Further template placeholders to remove, such as the Species template's "Trait" headings. */
    placeholder?: (block: Block) => boolean;
    /** Appended at the end of the page. */
    tail?: Block[];
}

/**
 * The template's page with its fields filled. Kept as the template has them:
 * the order of things, layouts, an infobox's shape, and `unsupported` blocks
 * (echoed by id, which the caller must have assigned). Removed: placeholder
 * text, the empty image slot when there is no image, and the template's
 * blank spacer paragraphs.
 */
export function fillTemplate(template: Block[], fill: TemplateFill): { blocks: Block[]; notes: string[] } {
    const fields = new Map(Object.entries(fill.fields).map(([title, value]) => [title.toLowerCase(), value]));
    const used = new Set<string>();
    let described = false;

    const fieldValue = (title: string | undefined): Block[] | null | undefined => {
        const key = (title ?? "").toLowerCase();
        if (!fields.has(key)) return undefined;
        used.add(key);
        return fields.get(key);
    };

    const walk = (blocks: Block[], top: boolean): Block[] =>
        blocks.flatMap((block): Block[] => {
            switch (block.kind) {
                case "unsupported":
                    return [{ kind: "unsupported", id: block.id! }];
                case "textField": {
                    const value = fieldValue(block.title);
                    if (value === null) return [];
                    return [value === undefined ? block : { ...block, children: value }];
                }
                case "infobox": {
                    const rows = block.rows.flatMap((row): PropertyBlock[] => {
                        if (row.kind !== "textField") return [row];
                        const value = fieldValue(row.title);
                        if (value === null) return [];
                        return [value === undefined ? row : { ...row, children: value }];
                    });
                    return rows.length ? [{ ...block, rows }] : [];
                }
                case "layout":
                case "layoutColumn": {
                    const children = walk(block.children, false);
                    return children.length ? [{ ...block, children }] : [];
                }
                case "image":
                    if (block.url) return [block];
                    return fill.image ? [{ ...block, url: fill.image.url, alt: fill.image.alt }] : [];
                case "paragraph": {
                    const text = plainText(block);
                    if (text === "Description") {
                        if (described) return [];
                        described = true;
                        return fill.description;
                    }
                    if (top && !text && !block.content.some((run) => "mention" in run)) return [];
                    break;
                }
            }
            return fill.placeholder?.(block) ? [] : [block];
        });

    const blocks = walk(template, true);
    const notes: string[] = [];
    if (!described) {
        blocks.unshift(...fill.description);
        notes.push('The template has no "Description" placeholder any more; the description went at the top.');
    }
    for (const [key, value] of fields) {
        if (used.has(key) || value === null) continue;
        const title = Object.keys(fill.fields).find((t) => t.toLowerCase() === key)!;
        blocks.push(textField(title, value));
        if (fill.optional?.some((t) => t.toLowerCase() === key)) continue;
        notes.push(`The template has no "${title}" field; it was added at the end of the page.`);
    }
    blocks.push(...(fill.tail ?? []));
    return { blocks, notes };
}

// ---------------------------------------------------------------------------
// Creating
// ---------------------------------------------------------------------------

export interface FilledCopyInput {
    template: ResourceListItem;
    name: string;
    parent: ResourceListItem;
    /** The article's tags in full: the template's own are replaced, not merged. */
    tags: string[];
    hidden: boolean;
    image?: FetchedImage;
    /** The asset library folder the image is stored in. */
    imageFolder: string;
    fill: (image?: StoredImage) => TemplateFill;
}

/** Copies the template, then tags it, sets its visibility and fills its first page tab. */
export async function createFilledCopy(lk: LegendKeeperClient, input: FilledCopyInput): Promise<Created> {
    const created = await lk.createFromTemplate({
        templateId: input.template.id,
        name: input.name,
        parentId: input.parent.id,
    });
    try {
        await lk.updateResource(created.id, { tags: input.tags, isHidden: input.hidden });
        const page = created.documents.find((doc) => doc.type === "page");
        if (!page) throw new Error("the copy has no page tab to write to");
        const image = input.image && (await storeImage(lk, input.image, input.name, input.imageFolder));

        let content = await lk.getDocumentBlocks(created.id, page.id);
        // A block needs an id to be echoed; pages written before block ids existed lack them.
        if (content.blocks.some((block) => !block.id)) {
            await lk.assignBlockIds(created.id, page.id);
            content = await lk.getDocumentBlocks(created.id, page.id);
        }
        const { blocks, notes } = fillTemplate(content.blocks, input.fill(image));
        await lk.replaceDocumentBlocks(created.id, page.id, blocks, content.version);
        return { id: created.id, notes };
    } catch (err) {
        throw new Error(
            `"${input.name}" was created (${created.id}) but could not be finished: ` +
                `${err instanceof Error ? err.message : String(err)}. ` +
                "The article exists as a bare copy of the template; finish or delete it in the app.",
        );
    }
}

export interface WholeInput {
    name: string;
    parent: ResourceListItem;
    tags: string[];
    hidden: boolean;
    image?: FetchedImage;
    imageFolder: string;
    documents: (image?: StoredImage) => { name: string; blocks: Block[] }[];
}

/** Stores the image, then creates the article with every tab in one request. */
export async function createWhole(lk: LegendKeeperClient, input: WholeInput): Promise<Created> {
    const image = input.image && (await storeImage(lk, input.image, input.name, input.imageFolder));
    const created = await lk.createResource({
        name: input.name,
        parentId: input.parent.id,
        tags: input.tags,
        isHidden: input.hidden,
        documents: input.documents(image).map((doc) => ({ ...doc, type: "page" as const })),
    });
    return { id: created.id, notes: [] };
}

async function storeImage(
    lk: LegendKeeperClient,
    image: FetchedImage,
    name: string,
    folder: string,
): Promise<StoredImage> {
    const asset = await lk.uploadImage({ ...image, name, folder });
    return { url: asset.url, alt: name };
}
