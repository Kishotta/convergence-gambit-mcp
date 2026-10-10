/**
 * ResourceIndex — the whole project tree in memory, for the questions the
 * API doesn't answer directly.
 *
 * The API reports `isHidden` per resource, but player visibility is
 * effective: per the charter's cascade rule, a hidden element hides every
 * descendant. Answering "can players see this?", building breadcrumb
 * paths, rendering the tree and filtering by tag all need the full
 * parent chain, so one listResources walk (paged at 100) builds this index
 * and every view shares it.
 *
 * Built only from the LegendKeeperClient seam; knows nothing of the SDK.
 */

import type { LegendKeeperClient, ResourceListItem } from "../lk/types";

/** Who a view is rendered for: the DM sees everything, players only revealed content. */
export type Audience = "dm" | "player";

export type Visibility =
    | { visible: true }
    /** `hiddenBy` is the resource itself, or the hidden ancestor that hides it. */
    | { visible: false; hiddenBy: { id: string; name: string } };

export interface TagUsage {
    tag: string;
    count: number;
    /** Carriers players can see. Charter §6: tags on these must be player-safe. */
    playerVisible: number;
}

export class ResourceIndex {
    private byId: Map<string, ResourceListItem>;
    private childrenOf = new Map<string | null, ResourceListItem[]>();

    constructor(
        resources: ResourceListItem[],
        /** When the snapshot was taken; views print it so staleness is visible. */
        readonly loadedAt = new Date(),
    ) {
        this.byId = new Map(resources.map((r) => [r.id, r]));
        for (const r of resources) {
            const key = this.parentKey(r);
            const siblings = this.childrenOf.get(key) ?? [];
            siblings.push(r);
            this.childrenOf.set(key, siblings);
        }
        for (const siblings of this.childrenOf.values()) siblings.sort(byRank);
    }

    static async load(lk: LegendKeeperClient): Promise<ResourceIndex> {
        return new ResourceIndex(await lk.listResources());
    }

    get size(): number {
        return this.byId.size;
    }

    get(id: string): ResourceListItem | undefined {
        return this.byId.get(id);
    }

    /** Direct children ordered as in the app; `null` for root resources. */
    children(id: string | null): ResourceListItem[] {
        return this.childrenOf.get(id) ?? [];
    }

    /** Ancestors from the root down, excluding the resource itself. */
    ancestors(id: string): ResourceListItem[] {
        const chain: ResourceListItem[] = [];
        const seen = new Set<string>([id]);
        let parentId = this.byId.get(id)?.parentId;
        while (parentId && !seen.has(parentId)) {
            const parent = this.byId.get(parentId);
            if (!parent) break;
            chain.unshift(parent);
            seen.add(parentId);
            parentId = parent.parentId;
        }
        return chain;
    }

    /** "Sigil / Lower Ward", or "(root)" for a root resource. */
    pathLabel(id: string): string {
        const names = this.ancestors(id).map((a) => a.name);
        return names.length ? names.join(" / ") : "(root)";
    }

    /**
     * Effective player visibility. Unknown ids (created since the index was
     * loaded) report visible here; callers holding the full resource should
     * also check its own `isHidden`.
     */
    visibility(id: string): Visibility {
        const self = this.byId.get(id);
        if (self?.isHidden) return { visible: false, hiddenBy: self };
        const hiddenAncestor = this.ancestors(id).find((a) => a.isHidden);
        return hiddenAncestor ? { visible: false, hiddenBy: hiddenAncestor } : { visible: true };
    }

    isPlayerVisible(id: string): boolean {
        return this.visibility(id).visible;
    }

    /** Resources carrying any (or all) of `tags`, case-insensitively, in tree order. */
    withTags(tags: string[], match: "any" | "all"): ResourceListItem[] {
        const wanted = tags.map((t) => t.toLowerCase());
        return this.inTreeOrder().filter((r) => {
            const have = new Set(r.tags.map((t) => t.toLowerCase()));
            return match === "all"
                ? wanted.every((t) => have.has(t))
                : wanted.some((t) => have.has(t));
        });
    }

    tagUsage(): TagUsage[] {
        const usage = new Map<string, TagUsage>();
        for (const r of this.byId.values()) {
            const visible = this.isPlayerVisible(r.id);
            for (const tag of r.tags) {
                const entry = usage.get(tag) ?? { tag, count: 0, playerVisible: 0 };
                entry.count++;
                if (visible) entry.playerVisible++;
                usage.set(tag, entry);
            }
        }
        return [...usage.values()].sort(
            (a, b) => b.count - a.count || a.tag.localeCompare(b.tag),
        );
    }

    /** Depth-first, siblings by rank — the order of the app's sidebar. */
    inTreeOrder(rootId: string | null = null): ResourceListItem[] {
        const out: ResourceListItem[] = [];
        const visit = (id: string | null) => {
            for (const child of this.children(id)) {
                out.push(child);
                visit(child.id);
            }
        };
        visit(rootId);
        return out;
    }

    /** A resource whose parent isn't in the index (deleted, or unreachable) is treated as a root. */
    private parentKey(r: ResourceListItem): string | null {
        return r.parentId && this.byId.has(r.parentId) ? r.parentId : null;
    }
}

/** Ranks are fractional indexes compared as plain strings; ties fall back to name. */
function byRank(a: ResourceListItem, b: ResourceListItem): number {
    const ra = a.rank ?? "";
    const rb = b.rank ?? "";
    if (ra !== rb) return ra < rb ? -1 : 1;
    return a.name.localeCompare(b.name);
}
