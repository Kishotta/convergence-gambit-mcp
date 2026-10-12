/**
 * create_magic_item — the first write view.
 *
 * A magic item article is a copy of one of the three templates under the
 * "Magic Item" template, and has five parts (charter §8):
 *
 *   sidebar  Tags       shows the resource's tags; not readable through the API
 *            Backlinks  dynamic: wherever the item is mentioned, so nothing to write
 *   body     Tags       the same display, as the page's first block
 *            Image      optional, wrapped to the right of the description;
 *                       an item without one drops the template's empty slot
 *            Description  what players read: appearance and, when revealed, effects
 *            Secret     the mechanics, until the item is identified
 *
 * Campaign rule: a Common item's mechanics are known on sight. From
 * Uncommon up they stay in the secret block until the party identifies the
 * item. A curse always gets a secret block of its own, after the mechanics.
 *
 * The copy keeps whatever the template puts above its "Description"
 * placeholder (the Tags display and the image slot, with the slot's layout);
 * the placeholder paragraph and placeholder secret are replaced. Every new
 * item is hidden: revealing it is a separate, deliberate act (reveal-and-tag).
 *
 * An image block only accepts an asset of this project, so an image given
 * as a web URL is downloaded and stored in the asset library first.
 */

import {
    IMAGE_CONTENT_TYPES,
    TEMPLATES_ROOT_ID,
    type Block,
    type ImageContentType,
    type LegendKeeperClient,
    type ResourceListItem,
} from "../lk/types";
import { composeBlocks } from "./compose";
import type { ResourceIndex } from "./index";

/** The template family and the reference folder, found by name so a recreated template still resolves. */
const FAMILY_TEMPLATE = "Magic Item";
const HOME_FOLDER = "Magic Items";
const ITEM_TAG = "Magic Item";
const ATTUNEMENT_TAG = "Requires Attunement";
/** The asset library folder item images are stored in. */
const IMAGE_FOLDER = "Magic Items";
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

export const ITEM_KINDS = {
    consumable: "Consumable",
    equipment: "Equipment",
    wondrous: "Wondrous Item",
} as const;
export type ItemKind = keyof typeof ITEM_KINDS;

export const RARITIES = ["Common", "Uncommon", "Rare", "Very Rare", "Legendary", "Artifact"] as const;
export type Rarity = (typeof RARITIES)[number];

export interface MagicItemInput {
    name: string;
    kind: ItemKind;
    rarity: Rarity;
    requiresAttunement: boolean;
    /** Form tags beyond kind and rarity, e.g. "Ring", "Weapon", "Potion". */
    tags: string[];
    /** Player-facing markdown. */
    description: string;
    mechanics?: string;
    curse?: string;
    /** A web image to store in the asset library and show beside the description. */
    imageUrl?: string;
    /** Default: only Common items show their mechanics. */
    mechanicsRevealed?: boolean;
    /** Default: the Magic Items folder. */
    parentId?: string;
}

/** Creates and populates the article; returns the new resource's id. */
export async function createMagicItem(
    lk: LegendKeeperClient,
    index: ResourceIndex,
    input: MagicItemInput,
): Promise<string> {
    const name = input.name.trim();
    const template = findTemplate(index, input.kind);
    const parent = findParent(index, input.parentId);

    const twin = index
        .withTags([ITEM_TAG], "all")
        .find((r) => r.name.trim().toLowerCase() === name.toLowerCase());
    if (twin) {
        throw new Error(
            `A magic item named "${twin.name}" already exists (${twin.id}, in ${index.pathLabel(twin.id)}). ` +
                "Nothing was created.",
        );
    }

    // Before anything is created, so a bad link leaves nothing behind.
    const image = input.imageUrl ? await fetchImage(input.imageUrl) : undefined;

    const created = await lk.createFromTemplate({ templateId: template.id, name, parentId: parent.id });

    try {
        const formTags = [...input.tags, input.rarity, ...(input.requiresAttunement ? [ATTUNEMENT_TAG] : [])];
        await lk.updateResource(created.id, { tags: mergeTags(created.tags, formTags), isHidden: true });

        const page = created.documents.find((doc) => doc.type === "page");
        if (!page) throw new Error("the copy has no page tab to write to");
        const asset = image && (await lk.uploadImage({ ...image, name, folder: IMAGE_FOLDER }));
        await writeBody(lk, created.id, page.id, input, asset && { url: asset.url, alt: name });
    } catch (err) {
        throw new Error(
            `"${name}" was created (${created.id}) but could not be finished: ` +
                `${err instanceof Error ? err.message : String(err)}. ` +
                "The article exists as a bare copy of the template; finish or delete it in the app.",
        );
    }
    return created.id;
}

async function writeBody(
    lk: LegendKeeperClient,
    resourceId: string,
    documentId: string,
    input: MagicItemInput,
    image?: { url: string; alt: string },
): Promise<void> {
    let page = await lk.getDocumentBlocks(resourceId, documentId);
    let kept = templateHead(page.blocks);
    // A block needs an id to be echoed; pages written before block ids existed lack them.
    if (kept.some((block) => !block.id)) {
        await lk.assignBlockIds(resourceId, documentId);
        page = await lk.getDocumentBlocks(resourceId, documentId);
        kept = templateHead(page.blocks);
    }

    const revealed = input.mechanicsRevealed ?? input.rarity === "Common";
    const mechanics = input.mechanics?.trim() ? composeBlocks(input.mechanics) : [];
    const curse = input.curse?.trim() ? composeBlocks(input.curse) : [];

    const head = kept
        // Most items have no artwork; an empty image slot would only be a blank frame.
        .filter((block) => block.kind !== "image" || image)
        .map((block): Block => {
            if (block.kind === "unsupported") return { kind: "unsupported", id: block.id! };
            return block.kind === "image" ? { ...block, ...image } : block;
        });
    // A template without an image slot still gets the image, laid out as the slot would be.
    if (image && !head.some((block) => block.kind === "image")) {
        head.push({ kind: "image", ...image, isTitleHidden: true, layout: "wrapRight", width: 50 });
    }

    const blocks: Block[] = [
        ...head,
        ...composeBlocks(input.description),
        ...(revealed ? mechanics : []),
        ...(!revealed && mechanics.length ? [secret(mechanics)] : []),
        ...(curse.length ? [secret(curse)] : []),
    ];
    await lk.replaceDocumentBlocks(resourceId, documentId, blocks, page.version);
}

/** What a template puts above its "Description" placeholder paragraph: the Tags display and the image slot. */
function templateHead(blocks: Block[]): Block[] {
    const placeholder = blocks.findIndex((block) => block.kind === "paragraph");
    return placeholder === -1 ? blocks : blocks.slice(0, placeholder);
}

async function fetchImage(url: string): Promise<{ data: Uint8Array; contentType: ImageContentType }> {
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

function secret(children: Block[]): Block {
    return { kind: "secret", children };
}

function findTemplate(index: ResourceIndex, kind: ItemKind): ResourceListItem {
    const family = index.children(TEMPLATES_ROOT_ID).find((t) => t.name === FAMILY_TEMPLATE);
    const template = family && index.children(family.id).find((t) => t.name === ITEM_KINDS[kind]);
    if (!template) {
        throw new Error(
            `Template "${FAMILY_TEMPLATE} / ${ITEM_KINDS[kind]}" not found (see list_templates). Nothing was created.`,
        );
    }
    return template;
}

function findParent(index: ResourceIndex, parentId?: string): ResourceListItem {
    if (parentId) {
        const parent = index.get(parentId);
        if (!parent) throw new Error(`Parent not found: ${parentId}. Nothing was created.`);
        if (index.isTemplate(parentId)) throw new Error(`${parent.name} is a template, not an article. Nothing was created.`);
        return parent;
    }
    const home = index.children(null).find((r) => r.name === HOME_FOLDER);
    if (!home) throw new Error(`The "${HOME_FOLDER}" folder was not found at the root. Nothing was created.`);
    return home;
}

/** The template's tags first, then the item's own, without case-insensitive repeats. */
function mergeTags(base: string[], extra: string[]): string[] {
    const seen = new Set<string>();
    return [...base, ...extra]
        .map((tag) => tag.trim())
        .filter((tag) => tag && !seen.has(tag.toLowerCase()) && seen.add(tag.toLowerCase()));
}
