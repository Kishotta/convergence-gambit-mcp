/**
 * Read-side views: what the MCP tools return. Each composes seam calls and
 * the ResourceIndex into markdown written for Claude to read: compact,
 * with ids for follow-up calls, and explicit about what players can and
 * can't see (charter §2–3).
 */

import {
    TEMPLATES_ROOT_ID,
    type Block,
    type LegendKeeperClient,
    type LKDocument,
    type Resource,
} from "../lk/types";
import type { Audience, ResourceIndex, Visibility } from "./index";
import { concealed, renderBlocks, renderProperty, type RenderContext } from "./render";
import { renderMap, renderTimeline } from "./spatial";

// ---------------------------------------------------------------------------
// read_article
// ---------------------------------------------------------------------------

export async function articleView(
    lk: LegendKeeperClient,
    index: ResourceIndex,
    resourceId: string,
    options: { audience: Audience; documentId?: string; blockIds?: boolean },
): Promise<string> {
    const { audience, documentId, blockIds } = options;
    const resource = await lk.getResource(resourceId);
    const visibility = effectiveVisibility(resource, index);
    // As with visibility, the index may predate a template created since it was loaded.
    const isTemplate = index.isTemplate(resource.id) || resource.parentId === TEMPLATES_ROOT_ID;

    const header = [
        `# ${resource.name}`,
        "",
        ...[
            `- **id:** ${resource.id}`,
            `- **path:** ${index.pathLabel(resource.id)}`,
            isTemplate ? "- **template:** yes, a skeleton for new articles, not a wiki article" : "",
            `- **players:** ${visibilityLabel(resource.id, visibility)}`,
            resource.tags.length ? `- **tags:** ${resource.tags.join(", ")}` : "",
            resource.aliases.length ? `- **aliases:** ${resource.aliases.join(", ")}` : "",
            resource.updatedAt ? `- **updated:** ${resource.updatedAt}` : "",
        ].filter(Boolean),
    ];

    if (audience === "player" && !visibility.visible) {
        return [...header, "", "Players cannot see this article at all, so the player view is empty."].join("\n");
    }

    const ctx: RenderContext = {
        audience,
        index,
        concealed: !visibility.visible,
        leaks: new Map(),
        blockIds,
    };
    const sections: string[] = [header.join("\n")];

    const properties = resource.properties
        .map((prop) => renderProperty(prop, ctx))
        .filter((out) => out !== "");
    if (properties.length) sections.push(`## Sidebar properties\n\n${properties.join("\n\n")}`);

    const tabs = [...resource.documents].sort((a, b) => (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : 0));
    const selected = documentId ? tabs.filter((doc) => doc.id === documentId) : tabs;
    if (documentId && selected.length === 0) {
        throw new Error(
            `Document ${documentId} is not a tab of ${resource.name}. Tabs: ` +
                tabs.map((doc) => `${doc.name} (${doc.id})`).join(", "),
        );
    }

    const rendered = await Promise.all(
        selected.map((doc) => tabSection(lk, resource, doc, ctx)),
    );
    sections.push(...rendered.filter((out) => out !== ""));

    if (ctx.leaks.size) {
        sections.push(
            "## Reveal-layer check\n\n" +
                "Player-visible content here links to articles players can't see. In page text each " +
                "renders as a dead link (the charter's one accepted leak); move crown-jewel names into a " +
                "secret block. Whether a visible timeline event linking one is auto-hidden is unverified.\n\n" +
                [...ctx.leaks].map(([id, name]) => `- [${name}](lk:${id})`).join("\n"),
        );
    }

    return sections.join("\n\n");
}

async function tabSection(
    lk: LegendKeeperClient,
    resource: Resource,
    doc: LKDocument,
    ctx: RenderContext,
): Promise<string> {
    if (doc.isHidden && ctx.audience === "player") return "";
    const heading =
        `## Tab: ${doc.name} (${doc.type}, ${doc.id})` + (doc.isHidden ? " 🔒 HIDDEN TAB, DM only" : "");

    const body = await tabBody(lk, resource.id, doc, ctx);
    return `${heading}\n\n${body}`;
}

async function tabBody(
    lk: LegendKeeperClient,
    resourceId: string,
    doc: LKDocument,
    ctx: RenderContext,
): Promise<string> {
    // Fetch before touching ctx: tabs render concurrently and share it.
    switch (doc.type) {
        case "page":
        case "blank": {
            let content = await lk.getDocumentBlocks(resourceId, doc.id);
            if (!ctx.blockIds) return inTab(doc, ctx, () => renderBlocks(content.blocks, ctx) || "(empty)");
            // A page written before block ids existed has none to show. Assigning them changes no content.
            if (lacksIds(content.blocks)) {
                await lk.assignBlockIds(resourceId, doc.id);
                content = await lk.getDocumentBlocks(resourceId, doc.id);
            }
            const body = inTab(doc, ctx, () => renderBlocks(content.blocks, ctx) || "(empty)");
            return `Document version \`${content.version}\`, for edit_page. Each ⟦…⟧ line is the id of the block under it, not content.\n\n${body}`;
        }
        case "map": {
            const features = await lk.listMapFeatures(resourceId, doc.id);
            return inTab(doc, ctx, () => renderMap(features, ctx));
        }
        case "time": {
            const [lanes, events] = await Promise.all([
                lk.listTimelineLanes(resourceId, doc.id),
                lk.listTimelineEvents(resourceId, doc.id),
            ]);
            return inTab(doc, ctx, () => renderTimeline(lanes, events, ctx));
        }
        default:
            return `(${doc.type} content isn't rendered by this server yet.)`;
    }
}

function lacksIds(blocks: Block[]): boolean {
    return blocks.some(
        (block) => !block.id || ("children" in block && !!block.children && lacksIds(block.children as Block[])),
    );
}

/** Renders a tab's content, concealed when the tab itself is hidden. */
function inTab(doc: LKDocument, ctx: RenderContext, render: () => string): string {
    return doc.isHidden ? concealed(ctx, render) : render();
}

/**
 * The index may predate the resource (created since it was loaded), so the
 * resource's own `isHidden` is checked too.
 */
function effectiveVisibility(resource: Resource, index: ResourceIndex): Visibility {
    if (resource.isHidden) return { visible: false, hiddenBy: resource };
    return index.visibility(resource.id);
}

function visibilityLabel(resourceId: string, visibility: Visibility): string {
    if (visibility.visible) return "visible (revealed)";
    return visibility.hiddenBy.id === resourceId
        ? "HIDDEN (this article is hidden)"
        : `HIDDEN (inside hidden "${visibility.hiddenBy.name}", ${visibility.hiddenBy.id})`;
}

// ---------------------------------------------------------------------------
// get_tree
// ---------------------------------------------------------------------------

export function treeView(
    index: ResourceIndex,
    options: { rootId?: string; maxDepth?: number; audience: Audience },
): string {
    const { rootId, maxDepth = Infinity, audience } = options;
    if (rootId && !index.get(rootId)) throw new Error(`Resource not found: ${rootId}`);

    const lines: string[] = [];
    const visit = (id: string | null, depth: number) => {
        for (const child of index.children(id)) {
            // A hidden resource hides its whole subtree from players.
            if (audience === "player" && child.isHidden) continue;
            lines.push(`${"  ".repeat(depth)}- ${resourceLine(child, audience === "dm")}`);
            if (depth + 1 < maxDepth) visit(child.id, depth + 1);
            else if (index.children(child.id).length) lines.push(`${"  ".repeat(depth + 1)}- …`);
        }
    };

    if (rootId) {
        const root = index.get(rootId)!;
        if (audience === "player" && !index.isPlayerVisible(rootId)) {
            return `${root.name} is hidden from players, so its subtree is empty in the player view.`;
        }
        lines.push(`- ${resourceLine(root, audience === "dm")}`);
        visit(rootId, 1);
    } else {
        visit(null, 0);
        // Templates are skeletons, not part of the wiki players browse.
        if (audience === "dm" && index.templateCount) {
            lines.push("", "Templates (skeletons, not wiki articles; see list_templates):", "");
            visit(TEMPLATES_ROOT_ID, 0);
        }
    }

    const templates = index.templateCount;
    return [
        `${index.size - templates} resources` +
            (templates ? ` and ${templates} template${templates === 1 ? "" : "s"}` : "") +
            ` (snapshot ${index.loadedAt.toISOString()}). ` +
            (audience === "dm"
                ? "🔒 marks a resource hidden from players; its whole subtree is hidden with it."
                : "Player view: hidden subtrees omitted."),
        "",
        ...lines,
    ].join("\n");
}

// ---------------------------------------------------------------------------
// list_templates
// ---------------------------------------------------------------------------

export function templatesView(index: ResourceIndex): string {
    const top = index.children(TEMPLATES_ROOT_ID);
    if (!top.length) return "No templates in the project.";

    const lines: string[] = [];
    const visit = (id: string, depth: number) => {
        for (const child of index.children(id)) {
            const tabs = child.documents.map((doc) => `${doc.name} (${doc.type})`).join(", ");
            lines.push(`${"  ".repeat(depth)}- ${resourceLine(child, true)} · tabs: ${tabs || "none"}`);
            visit(child.id, depth + 1);
        }
    };
    visit(TEMPLATES_ROOT_ID, 0);

    return [
        `${top.length} template${top.length === 1 ? "" : "s"}, ${index.templateCount} resources with their ` +
            `nested ones (snapshot ${index.loadedAt.toISOString()}). A template is a skeleton for new ` +
            "articles, not a wiki article: search and the tag tools leave it out. Nested resources are " +
            "templates too, and can be copied along with their parent. Read a skeleton with read_article.",
        "",
        ...lines,
    ].join("\n");
}

// ---------------------------------------------------------------------------
// find_by_tag / list_tags
// ---------------------------------------------------------------------------

export function taggedView(
    index: ResourceIndex,
    options: { tags: string[]; match: "any" | "all"; audience: Audience },
): string {
    const { tags, match, audience } = options;
    const found = index
        .withTags(tags, match)
        .filter((r) => audience === "dm" || index.isPlayerVisible(r.id));
    const title = `Resources tagged ${tags.map((t) => `"${t}"`).join(match === "all" ? " and " : " or ")}`;
    if (!found.length) return `${title}: none${audience === "player" ? " visible to players" : ""}.`;
    return [
        `${title} (${found.length}${audience === "player" ? ", player view" : ""}):`,
        "",
        ...found.map((r) => `- ${resourceLine(r, audience === "dm")} · ${index.pathLabel(r.id)}`),
    ].join("\n");
}

export function tagsView(index: ResourceIndex): string {
    const usage = index.tagUsage();
    if (!usage.length) return "No tags in the project.";
    return [
        "Tags by use. `players` counts the carriers players can see: per charter §6, any tag on a " +
            "player-visible resource must be player-safe, so DM-only grouping tags should read 0. " +
            "Tags on templates are not counted.",
        "",
        "| tag | resources | players |",
        "| --- | --- | --- |",
        ...usage.map((u) => `| ${u.tag} | ${u.count} | ${u.playerVisible} |`),
    ].join("\n");
}

// ---------------------------------------------------------------------------
// search
// ---------------------------------------------------------------------------

export async function searchView(
    lk: LegendKeeperClient,
    index: ResourceIndex,
    query: string,
    limit: number,
): Promise<string> {
    const hits = await lk.search(query, limit);
    if (!hits.length) return `No matches for "${query}".`;
    return [
        `${hits.length} match${hits.length === 1 ? "" : "es"} for "${query}", best first. ` +
            "Snippets can quote secret blocks and hidden tabs; check visibility with read_article before reusing them.",
        "",
        ...hits.map(({ resource, document }) => {
            const hidden = index.get(resource.id) && !index.isPlayerVisible(resource.id) ? " 🔒" : "";
            const path = resource.path?.length ? resource.path.map((a) => a.name).join(" / ") : "(root)";
            let line = `- **${resource.name}** (${resource.id})${hidden} · ${path}`;
            if (document) {
                const snippet = document.highlights?.[0]?.segment?.replace(/\s+/g, " ").trim();
                line += `\n  in tab "${document.name}" (${document.id})${snippet ? `: …${snippet}…` : ""}`;
            } else {
                line += "\n  (matched name or alias)";
            }
            return line;
        }),
    ].join("\n");
}

// ---------------------------------------------------------------------------

function resourceLine(
    r: { id: string; name: string; tags: string[]; isHidden?: boolean },
    markHidden: boolean,
): string {
    const tags = r.tags.length ? " " + r.tags.map((t) => `#${t}`).join(" ") : "";
    const hidden = markHidden && r.isHidden ? " 🔒" : "";
    return `${r.name} (${r.id})${hidden}${tags}`;
}
