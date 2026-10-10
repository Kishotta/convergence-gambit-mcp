/**
 * Block tree → markdown, rendered for one audience.
 *
 * LegendKeeper pages are typed block trees (see src/lk/types.ts). Raw, they
 * are verbose JSON; as markdown they read naturally and cost a fraction of
 * the context. The renderer is the read-side half of the charter's
 * two-layer model:
 *
 * - `dm` renders everything, marking each concealed layer inline (secret
 *   blocks, hidden properties) so Claude always knows what players can't see.
 * - `player` drops secret blocks, hidden properties and links to hidden
 *   resources, the way LegendKeeper presents the page to a player.
 *
 * Mentions render as `[Name](lk:resourceId)`, so Claude can follow one with
 * `read_article`. A mention of a player-hidden resource from player-visible
 * text is the charter's "one accepted leak" (a dead link that confirms the
 * name exists); those are collected in `ctx.leaks` for the reveal-layer check.
 */

import type { Block, Mention, PropertyBlock, Run } from "../lk/types";
import type { Audience, ResourceIndex } from "./index";

export interface RenderContext {
    audience: Audience;
    index: ResourceIndex;
    /** True while rendering content players can't see (secret block, hidden tab/property/resource). */
    concealed: boolean;
    /** Player-hidden resources named in player-visible text, keyed by id. */
    leaks: Map<string, string>;
}

type BlockOf<K extends Block["kind"]> = Extract<Block, { kind: K }>;

const HIDDEN = "⟨hidden from players⟩";

export function renderBlocks(blocks: Block[] | undefined, ctx: RenderContext): string {
    return (blocks ?? [])
        .map((block) => renderBlock(block, ctx))
        .filter((out) => out.trim() !== "")
        .join("\n\n");
}

function renderBlock(block: Block, ctx: RenderContext): string {
    switch (block.kind) {
        case "paragraph":
            return runs(block.content, ctx);
        case "heading":
            // Tabs render as "##", so page headings start at "###".
            return `${"#".repeat(Math.min(6, block.level + 2))} ${runs(block.content, ctx)}`;
        case "quote":
            return quote(renderBlocks(block.children, ctx));
        case "code":
            return "```" + (block.language ?? "") + "\n" + block.text + "\n```";
        case "rule":
            return "---";
        case "bulletList":
            return block.children.map((child) => listItem(child, "- ", ctx)).join("\n");
        case "orderedList":
            return block.children
                .map((child, i) => listItem(child, `${(block.start ?? 1) + i}. `, ctx))
                .join("\n");
        case "taskList":
            return block.children.map((child) => listItem(child, "", ctx)).join("\n");
        case "taskItem":
            return `- [${block.checked ? "x" : " "}] ${runs(block.content, ctx)}`;
        case "listItem":
        case "layout":
        case "layoutColumn":
        case "tableRow":
        case "tableCell":
            return renderBlocks(block.children, ctx);
        case "table":
            return table(block, ctx);
        case "callout":
            return quote(
                `**${block.tone === "custom" ? "Callout" : capitalize(block.tone)}:**\n\n` +
                    renderBlocks(block.children, ctx),
            );
        case "expand":
            return quote(`**▸ ${block.title}** (collapsible)\n\n${renderBlocks(block.children, ctx)}`);
        case "secret":
            if (ctx.audience === "player") return "";
            return concealed(ctx, () =>
                quote(
                    "🔒 **SECRET BLOCK** — players see nothing here until it is revealed\n\n" +
                        renderBlocks(block.children, ctx),
                ),
            );
        case "textField":
            return titled(block.title, renderBlocks(block.children, ctx));
        case "infobox":
            return quote(
                "**Infobox**\n\n" +
                    block.rows
                        .map((row) => renderProperty(row, ctx))
                        .filter((out) => out !== "")
                        .join("\n\n"),
            );
        case "image":
            return image(block.url, block.alt ?? block.title);
        case "embed":
            return `[${block.provider} embed: ${block.title ?? block.url}](${block.url})`;
        case "keyValue":
            return titled(block.title, keyValueRows(block.rows, ctx));
        case "meter":
            return titled(block.title ?? "Meter", meterItems(block.items));
        case "resourceCollection":
            return titled(
                block.title ?? "Collection",
                resourceItems(block.items, ctx, block.filter),
            );
        case "resourceLink":
            return titled(block.title ?? "Links", resourceItems(block.items, ctx));
        case "map":
            return `[Embedded map${block.resourceId ? ` of ${linkTo(block.resourceId, undefined, ctx)}` : ""}]`;
        case "unsupported":
            return `[unsupported content, block ${block.id}: not readable through the API]`;
        default:
            return `[unknown block kind "${(block as { kind: string }).kind}"]`;
    }
}

/**
 * A sidebar or infobox property. Hidden properties are omitted for
 * players and marked for the DM.
 */
export function renderProperty(prop: PropertyBlock, ctx: RenderContext): string {
    if (prop.isHidden && ctx.audience === "player") return "";
    const render = () => {
        const title =
            `**${prop.title ?? capitalize(prop.kind)}**` + (prop.isHidden ? ` 🔒 hidden property` : "");
        return `${title}\n${propertyBody(prop, ctx)}`;
    };
    return prop.isHidden ? concealed(ctx, render) : render();
}

function propertyBody(prop: PropertyBlock, ctx: RenderContext): string {
    switch (prop.kind) {
        case "textField":
            return renderBlocks(prop.children, ctx);
        case "keyValue":
            return keyValueRows(prop.rows, ctx);
        case "image":
            return image(prop.url, prop.alt);
        case "meter":
            return meterItems(prop.items);
        case "resourceCollection":
            return resourceItems(prop.items, ctx, prop.filter);
        case "resourceLink":
            return resourceItems(prop.items, ctx);
        case "embed":
            return `[${prop.provider} embed](${prop.url})`;
        case "map":
            return `[Embedded map${prop.resourceId ? ` of ${linkTo(prop.resourceId, undefined, ctx)}` : ""}]`;
        case "unsupported":
            return `[unsupported property ${prop.id}: not readable through the API]`;
        default:
            return `[unknown property kind "${(prop as { kind: string }).kind}"]`;
    }
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

function runs(content: Run[] | undefined, ctx: RenderContext): string {
    return (content ?? [])
        .map((run) => {
            if ("break" in run) return "  \n";
            if ("mention" in run) {
                const m: Mention = run.mention;
                return linkTo(m.resourceId, m.text ?? m.name, ctx);
            }
            if (run.code) return "`" + run.text + "`";
            let text = run.text;
            if (run.bold) text = `**${text}**`;
            if (run.italic) text = `_${text}_`;
            if (run.strike) text = `~~${text}~~`;
            if (run.link) text = `[${text}](${run.link})`;
            return text;
        })
        .join("");
}

/**
 * A link to a resource as `[Name](lk:id)`, marked when players can't see
 * the target. Outside concealed content, such a link is a leak.
 */
export function linkTo(resourceId: string, label: string | undefined, ctx: RenderContext): string {
    const target = ctx.index.get(resourceId);
    const name = label || target?.name || resourceId;
    const hidden = target !== undefined && !ctx.index.isPlayerVisible(resourceId);
    if (hidden && !ctx.concealed) ctx.leaks.set(resourceId, target.name);
    return `[${name}](lk:${resourceId})` + (hidden ? ` ${HIDDEN}` : "");
}

/**
 * The resource id an `lk://` uri points at (map features and timeline
 * events link this way): `lk://resources/<id>` or
 * `lk://resources/<id>/docs/<docId>`. A bare `lk://documents/<docId>`
 * names no resource, so it yields undefined.
 */
export function resourceIdOf(uri: string | undefined): string | undefined {
    return uri?.match(/^lk:\/\/resources\/([^/]+)/)?.[1];
}

/** Linked resources; players see only the ones revealed to them. */
function resourceItems(
    items: { resourceId: string }[] | undefined,
    ctx: RenderContext,
    filter?: unknown,
): string {
    const lines = (items ?? [])
        .filter((item) => ctx.audience === "dm" || ctx.index.isPlayerVisible(item.resourceId))
        .map((item) => `- ${linkTo(item.resourceId, undefined, ctx)}`);
    if (filter) lines.push(`- (dynamic, filter: \`${JSON.stringify(filter)}\`)`);
    return lines.join("\n") || "(empty)";
}

function keyValueRows(
    rows: { key: string; content?: Run[]; text?: string }[],
    ctx: RenderContext,
): string {
    return rows
        .map((row) => `- **${row.key}:** ${row.content ? runs(row.content, ctx) : (row.text ?? "")}`)
        .join("\n");
}

function meterItems(items: { name: string; current: number; max: number }[]): string {
    return items.map((item) => `- ${item.name}: ${item.current}/${item.max}`).join("\n");
}

function table(block: BlockOf<"table">, ctx: RenderContext): string {
    const rows = block.children.map((row) =>
        "children" in row
            ? row.children.map((cell) =>
                  renderBlock(cell, ctx).replace(/\n+/g, " <br> ").replace(/\|/g, "\\|"),
              )
            : [renderBlock(row, ctx)],
    );
    if (rows.length === 0) return "";
    const width = Math.max(...rows.map((cells) => cells.length));
    const line = (cells: string[]) =>
        `| ${[...cells, ...Array(width - cells.length).fill("")].join(" | ")} |`;
    const [header, ...body] = rows;
    return [line(header), line(Array(width).fill("---")), ...body.map(line)].join("\n");
}

function listItem(block: Block, marker: string, ctx: RenderContext): string {
    const [first = "", ...rest] = renderBlock(block, ctx).split("\n");
    const indent = " ".repeat(marker.length);
    return [marker + first, ...rest.map((l) => (l ? indent + l : l))].join("\n");
}

function image(url: string, alt?: string): string {
    return `![${alt ?? "image"}](${url})`;
}

function titled(title: string | undefined, body: string): string {
    return title ? `**${title}**\n${body}` : body;
}

function quote(body: string): string {
    return body
        .split("\n")
        .map((l) => (l ? `> ${l}` : ">"))
        .join("\n");
}

/** Renders with `ctx.concealed` set, so links inside don't count as leaks. */
export function concealed<T>(ctx: RenderContext, render: () => T): T {
    const previous = ctx.concealed;
    ctx.concealed = true;
    try {
        return render();
    } finally {
        ctx.concealed = previous;
    }
}

function capitalize(s: string): string {
    return s.charAt(0).toUpperCase() + s.slice(1);
}
