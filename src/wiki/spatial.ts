/**
 * Map and timeline tabs → markdown, rendered for one audience.
 *
 * Both are lists of things that may link to an article (`uri`) and may be
 * hidden (`isHidden`), so they get the same treatment as page content: the
 * DM view marks every concealed item, the player view drops them, and a
 * visible item linking to a hidden article is a leak.
 *
 * A pin is just a pin: on Sigil's map it may stand for a building or a whole
 * settlement, on a battle map for a keyed room. Nothing here assumes which.
 *
 * Visibility rules, and how sure we are of each:
 * - Hidden features and events are invisible to players (API: a non-admin
 *   caller doesn't receive them).
 * - A non-hidden pin linking to a hidden article is auto-hidden (charter §2).
 *   The player view drops it rather than reporting a leak.
 * - Whether a hidden folder hides the features inside it is unverified. The
 *   player view keeps them and says so: for a spoiler check, wrongly
 *   reporting something as hidden is the dangerous mistake.
 * - Whether an event linking to a hidden article is auto-hidden is
 *   unverified. It is reported as a leak, like a mention.
 */

import type { MapFeature, TimelineEvent, TimelineLane } from "../lk/types";
import { concealed, linkTo, resourceIdOf, type RenderContext } from "./render";

// ---------------------------------------------------------------------------
// Maps
// ---------------------------------------------------------------------------

export function renderMap(features: MapFeature[], ctx: RenderContext): string {
    if (features.length === 0) return "(no pins, regions or labels)";

    const ids = new Set(features.map((f) => f.id));
    const childrenOf = new Map<string | null, MapFeature[]>();
    for (const feature of features) {
        const key = feature.parentId && ids.has(feature.parentId) ? feature.parentId : null;
        const siblings = childrenOf.get(key) ?? [];
        siblings.push(feature);
        childrenOf.set(key, siblings);
    }
    for (const siblings of childrenOf.values()) {
        siblings.sort((a, b) => ((a.rank ?? "") < (b.rank ?? "") ? -1 : (a.rank ?? "") > (b.rank ?? "") ? 1 : 0));
    }

    const lines: string[] = [];
    const visit = (parentId: string | null, depth: number) => {
        for (const feature of childrenOf.get(parentId) ?? []) {
            const line = featureLine(feature, ctx);
            if (line === undefined) continue;
            const indent = "  ".repeat(depth);
            const hides = feature.isHidden || autoHidden(feature, ctx);
            const render = () => {
                lines.push(indent + line);
                visit(feature.id, depth + 1);
            };
            if (hides) concealed(ctx, render);
            else render();
        }
    };
    visit(null, 0);

    const counts = new Map<string, number>();
    for (const f of features) counts.set(f.type ?? "feature", (counts.get(f.type ?? "feature") ?? 0) + 1);
    const summary = [...counts].map(([type, n]) => `${n} ${type}${n === 1 ? "" : "s"}`).join(", ");
    return `${summary}. Folders and regions list what they contain.\n\n${lines.join("\n")}`;
}

/** One feature's line, or undefined when players can't see it in the player view. */
function featureLine(feature: MapFeature, ctx: RenderContext): string | undefined {
    const isAutoHidden = autoHidden(feature, ctx);
    if (ctx.audience === "player" && (feature.isHidden || isAutoHidden) && feature.type !== "folder") {
        return undefined;
    }

    let line = `- ${feature.name || "(unnamed)"}${feature.type === "folder" ? "/" : ""} (${feature.type ?? "feature"})`;
    const target = resourceIdOf(feature.uri);
    const linked = () => (target ? ` → ${linkTo(target, undefined, ctx)}` : "");

    if (feature.type === "folder" && feature.isHidden) {
        return ctx.audience === "player"
            ? `${line} — hidden folder; whether its contents are hidden with it is unverified`
            : `${line} 🔒 hidden folder`;
    }
    if (feature.isHidden) return concealed(ctx, () => `${line}${linked()} 🔒 hidden`);
    if (isAutoHidden) {
        return concealed(ctx, () => `${line}${linked()} 🔒 auto-hidden: links to an article players can't see`);
    }
    line += linked();
    return line;
}

/** Charter §2: a pin linking to a hidden article is hidden with it. */
function autoHidden(feature: MapFeature, ctx: RenderContext): boolean {
    if (feature.type !== "pin" || feature.isHidden) return false;
    const target = resourceIdOf(feature.uri);
    return target !== undefined && ctx.index.get(target) !== undefined && !ctx.index.isPlayerVisible(target);
}

// ---------------------------------------------------------------------------
// Timelines
// ---------------------------------------------------------------------------

export function renderTimeline(
    lanes: TimelineLane[],
    events: TimelineEvent[],
    ctx: RenderContext,
): string {
    if (events.length === 0) return "(no events)";

    const byLane = new Map<string, TimelineEvent[]>();
    for (const event of events) {
        const lane = byLane.get(event.laneId) ?? [];
        lane.push(event);
        byLane.set(event.laneId, lane);
    }

    const sortedLanes = [...lanes].sort((a, b) => (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : 0));
    const knownLaneIds = new Set(lanes.map((lane) => lane.id));
    const groups: Array<{ name: string; events: TimelineEvent[] }> = sortedLanes.map((lane) => ({
        name: lane.name,
        events: byLane.get(lane.id) ?? [],
    }));
    const orphans = events.filter((event) => !knownLaneIds.has(event.laneId));
    if (orphans.length) groups.push({ name: "(no lane)", events: orphans });

    const sections = groups
        .map(({ name, events: laneEvents }) => {
            const lines = laneEvents
                .sort((a, b) => a.start - b.start)
                .map((event) => eventLine(event, ctx))
                .filter((line): line is string => line !== undefined);
            return lines.length ? `**Lane: ${name}**\n${lines.join("\n")}` : "";
        })
        .filter(Boolean);

    return sections.join("\n\n") || "(no events players can see)";
}

function eventLine(event: TimelineEvent, ctx: RenderContext): string | undefined {
    if (event.isHidden && ctx.audience === "player") return undefined;
    const render = () => {
        const end = event.formattedEnd ? ` – ${event.formattedEnd}` : "";
        const kind = event.type === "event" ? "" : ` (${event.type})`;
        const target = resourceIdOf(event.uri);
        const link = target ? ` → ${linkTo(target, undefined, ctx)}` : "";
        return `- ${dateOf(event)}${end}: ${event.name ?? "(unnamed)"}${kind}${link}` +
            (event.isHidden ? " 🔒 hidden event" : "");
    };
    return event.isHidden ? concealed(ctx, render) : render();
}

/** The date as the app shows it, or a fallback built from the resolved date. */
function dateOf(event: TimelineEvent): string {
    if (event.formattedStart) return event.formattedStart;
    const { year, monthName, day, era } = event.startDate;
    return `${day} ${monthName} ${year} ${era.abbr}`;
}
