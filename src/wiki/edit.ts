/**
 * edit_page — block-level edits to one page tab of an existing article.
 *
 * The catch-all write view, for bringing an article that is incomplete or
 * stale in line with newer notes: insert markdown at a place, replace a
 * block, delete a block. Blocks are named by the ids read_article prints
 * with `blockIds`, and the edit must quote the document version from that
 * read, so it fails rather than overwrite a change made since.
 *
 * Each operation goes to the API's per-block endpoints. Only the blocks
 * named are written: an infobox, a layout or an `unsupported` block
 * elsewhere on the page is never read back and rewritten. The price is
 * that a batch is not atomic. Everything that can be checked is checked
 * before the first write; after that, operations apply in order and stop
 * at the first failure, and the error says what landed.
 *
 * Secrecy is explicit (charter §2: the secret block is the block-level
 * reveal layer), and never inferred from the text:
 *
 * - An insert lands where it is put. Next to or inside a secret block, it
 *   is secret. Anywhere else it is player-facing, unless `secret` is set,
 *   which wraps it in a new secret block.
 * - A replace keeps what the block was. Replacing a secret block (a
 *   template's placeholder secret, say) rewrites its contents and it stays
 *   secret. `secret: true` turns a visible block into a secret one;
 *   `secret: false` on a secret block is a reveal, and is reported as one.
 *
 * Markdown copied from a read can carry the renderer's annotations. Written
 * back they would become content, and a secret block's rendering would
 * become a visible quote holding the secret, so they are refused.
 */

import type { Block, BlockPlacement, LegendKeeperClient } from "../lk/types";
import { composeBlocks } from "./compose";
import type { ResourceIndex } from "./index";
import { BLOCK_MARKER, HIDDEN, SECRET_HEADING, renderBlocks } from "./render";

export type EditOperation =
    | { op: "insert"; markdown: string; after?: string; before?: string; parent?: string; secret?: boolean }
    | { op: "replace"; blockId: string; markdown: string; secret?: boolean }
    | { op: "delete"; blockId: string };

export interface EditPageInput {
    resourceId: string;
    documentId: string;
    /** The document version the block ids were read at. */
    version: string;
    operations: EditOperation[];
}

/** A block of the page as it stood before the edit. */
interface Located {
    block: Block;
    /** Ids of the blocks it sits inside, outermost first. */
    ancestors: string[];
    /** Whether one of those is a secret block. */
    inSecret: boolean;
}

/** An operation checked against the page and ready to send. */
type Step =
    | { op: "insert"; blocks: Block[]; at: BlockPlacement; layer: string }
    | { op: "replace"; target: Located; first: Block; rest: Block[]; layer: string }
    | { op: "delete"; target: Located };

const NOTHING_WRITTEN = "Nothing was written.";

/** Applies the operations in order and returns a report of each, in markdown. */
export async function editPage(
    lk: LegendKeeperClient,
    index: ResourceIndex,
    input: EditPageInput,
): Promise<string> {
    const { resourceId, documentId } = input;
    const resource = await lk.getResource(resourceId);
    const doc = resource.documents.find((d) => d.id === documentId);
    if (!doc) {
        throw new Error(
            `Document ${documentId} is not a tab of ${resource.name}. Tabs: ` +
                resource.documents.map((d) => `${d.name} (${d.id})`).join(", ") +
                `. ${NOTHING_WRITTEN}`,
        );
    }
    if (doc.type !== "page" && doc.type !== "blank") {
        throw new Error(`Tab "${doc.name}" is a ${doc.type} document, not a page. ${NOTHING_WRITTEN}`);
    }

    const page = await lk.getDocumentBlocks(resourceId, documentId);
    if (page.version !== input.version) {
        throw new Error(
            `Tab "${doc.name}" has changed since version ${input.version} (it is now ${page.version}). ` +
                `Read it again with read_article and blockIds, then retry. ${NOTHING_WRITTEN}`,
        );
    }

    const steps = plan(input.operations, locate(page.blocks));

    /** The old content of a block, for the report: what a replace or delete took away. */
    const was = (block: Block) =>
        renderBlocks([block], { audience: "dm", index, concealed: true, leaks: new Map() }) || `(empty ${block.kind})`;

    let version = page.version;
    let writes = 0;
    const insertAll = async (blocks: Block[], at: BlockPlacement): Promise<string[]> => {
        const ids: string[] = [];
        for (const block of blocks) {
            // The first goes where asked; each one after it follows the one before.
            const place = ids.length ? { after: ids[ids.length - 1] } : at;
            const inserted = await lk.insertBlock(resourceId, documentId, block, place, version);
            version = inserted.version;
            writes++;
            ids.push(inserted.id);
        }
        return ids;
    };

    const report: string[] = [];
    for (const [i, step] of steps.entries()) {
        const before = writes;
        try {
            if (step.op === "insert") {
                const ids = await insertAll(step.blocks, step.at);
                report.push(`${i + 1}. Inserted ${ids.map((id) => `⟦${id}⟧`).join(" ")}: ${step.layer}.`);
            } else if (step.op === "replace") {
                const id = step.target.block.id!;
                version = (await lk.replaceBlock(resourceId, documentId, id, step.first, version)).version;
                writes++;
                const ids = await insertAll(step.rest, { after: id });
                report.push(
                    `${i + 1}. Replaced ⟦${id}⟧${ids.length ? `, continuing in ${ids.map((n) => `⟦${n}⟧`).join(" ")}` : ""}: ` +
                        `${step.layer}. It was:\n\n${was(step.target.block)}`,
                );
            } else {
                const id = step.target.block.id!;
                await lk.deleteBlock(resourceId, documentId, id, version);
                writes++;
                // A delete answers with no body, so the new version takes a read.
                version = (await lk.getDocumentBlocks(resourceId, documentId)).version;
                report.push(`${i + 1}. Deleted ⟦${id}⟧. It was:\n\n${was(step.target.block)}`);
            }
        } catch (err) {
            const reason = err instanceof Error ? err.message : String(err);
            if (!writes) throw new Error(`Operation ${i + 1} failed: ${reason}. ${NOTHING_WRITTEN}`);
            const summary = [
                `Operation ${i + 1} of ${steps.length} failed: ${reason}.`,
                writes > before ? "It was partly applied." : "It changed nothing.",
                i ? `Earlier operations (${i}) applied and are reported below.` : "",
                i + 1 < steps.length ? "The ones after it were not attempted." : "",
                "Read the tab again before retrying: its version and block ids have changed.",
            ];
            throw new Error([summary.filter(Boolean).join(" "), ...report].join("\n\n"));
        }
    }
    return report.join("\n\n");
}

/**
 * Checks every operation against the page as it stands and composes its
 * blocks, so that a mistake in the request fails before anything is
 * written. Throws on the first operation that can't work.
 */
function plan(operations: EditOperation[], found: Map<string, Located>): Step[] {
    /** Blocks an earlier operation deletes, and blocks it replaces (whose old children are gone) with what replaces them. */
    const deleted = new Set<string>();
    const replaced = new Map<string, Block>();

    return operations.map((operation, i): Step => {
        const fail = (why: string) => new Error(`Operation ${i + 1} (${operation.op}): ${why}. ${NOTHING_WRITTEN}`);

        const resolve = (id: string): Located => {
            const located = found.get(id);
            if (!located) throw fail(`there is no block ${id} in this tab`);
            if (deleted.has(id) || located.ancestors.some((a) => deleted.has(a) || replaced.has(a))) {
                throw fail(`block ${id} is removed by an earlier operation in this call`);
            }
            return located;
        };

        const compose = (markdown: string): Block[] => {
            if (markdown.includes(SECRET_HEADING)) {
                throw fail(
                    "the markdown holds a rendered secret block, which would be written as a visible quote; " +
                        "pass the secret's text alone, with `secret: true` or a secret block as `parent`",
                );
            }
            if (BLOCK_MARKER.test(markdown)) throw fail("the markdown holds a ⟦block id⟧ line, which is not content");
            // The mark read_article puts after a link players can't follow.
            const blocks = composeBlocks(markdown.split(` ${HIDDEN}`).join(""));
            if (!blocks.length) throw fail("the markdown is empty");
            return blocks;
        };

        if (operation.op === "delete") {
            const target = resolve(operation.blockId);
            deleted.add(operation.blockId);
            return { op: "delete", target };
        }

        if (operation.op === "replace") {
            const target = resolve(operation.blockId);
            const blocks = compose(operation.markdown);
            const wasSecret = target.block.kind === "secret";
            const wrap = wasSecret ? operation.secret !== false : operation.secret === true && !target.inSecret;
            const [first, ...rest] = wrap ? [secret(blocks)] : blocks;
            replaced.set(operation.blockId, first);
            let layer = layerOf(target.inSecret, wrap);
            if (wasSecret && wrap) layer = "SECRET, still a secret block, with new contents";
            else if (wasSecret && !target.inSecret) layer = `REVEALED, it was a secret block. Now ${layer}`;
            return { op: "replace", target, first, rest, layer };
        }

        const places = [operation.after, operation.before, operation.parent].filter((id) => id !== undefined);
        if (places.length > 1) throw fail("give at most one of `after`, `before` and `parent`");
        let inSecret = false;
        if (operation.parent !== undefined) {
            const parent = resolve(operation.parent);
            // As an earlier operation in this call leaves it, which may no longer be a secret block.
            const block = replaced.get(operation.parent) ?? parent.block;
            if (!("children" in block)) throw fail(`block ${operation.parent} is a ${block.kind}, which holds no blocks`);
            inSecret = parent.inSecret || block.kind === "secret";
        } else if (places.length) {
            inSecret = resolve(places[0]).inSecret;
        }
        const blocks = compose(operation.markdown);
        const wrap = operation.secret === true && !inSecret;
        return {
            op: "insert",
            blocks: wrap ? [secret(blocks)] : blocks,
            at: { after: operation.after, before: operation.before, parent: operation.parent },
            layer: layerOf(inSecret, wrap),
        };
    });
}

/** Which reveal layer written content ends up in, said the same way every time. */
function layerOf(inSecret: boolean, wrapped: boolean): string {
    if (wrapped) return "SECRET, in a new secret block";
    if (inSecret) return "SECRET, inside an existing secret block";
    return "PLAYER-FACING, outside any secret block (players read it once they can see this tab)";
}

function secret(children: Block[]): Block {
    return { kind: "secret", children };
}

/** Every block of the page that has an id, with where it sits. */
function locate(
    blocks: Block[],
    found = new Map<string, Located>(),
    ancestors: string[] = [],
    inSecret = false,
): Map<string, Located> {
    for (const block of blocks) {
        if (block.id) found.set(block.id, { block, ancestors, inSecret });
        if ("children" in block && block.children) {
            locate(
                block.children as Block[],
                found,
                block.id ? [...ancestors, block.id] : ancestors,
                inSecret || block.kind === "secret",
            );
        }
    }
    return found;
}
