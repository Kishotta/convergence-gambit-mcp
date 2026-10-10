/**
 * Nightly backup export.
 *
 * Fires on the cron trigger configured in wrangler.jsonc. The v3 API has no
 * whole-project export endpoint, so the snapshot is synthesized through the
 * LegendKeeperClient seam: every resource (with its tabs and sidebar
 * properties), the block tree of every page tab, the features of every map
 * tab and the lanes and events of every timeline tab. Written to R2 as one
 * object per night, then anything older than RETENTION_DAYS is pruned.
 *
 * Not yet captured: board records, assets (map images, uploads), and
 * deleted resources in the trash.
 */

import type { Env } from "./env";
import { createLegendKeeperClient } from "./lk/client";
import type {
    DocumentBlocks,
    LegendKeeperClient,
    MapFeature,
    Resource,
    TimelineEvent,
    TimelineLane,
} from "./lk/types";

const RETENTION_DAYS = 30;
const KEY_PREFIX = "snapshots/";

/**
 * Pause between API reads. The key's budget is 300 requests a minute,
 * shared with any live Claude session; ~120/min leaves most of it free.
 * A few hundred resources finish well inside a cron's 15-minute limit.
 */
const REQUEST_SPACING_MS = 500;

export type BackupEnv = Pick<Env, "BACKUPS" | "LK_API_KEY" | "LK_PROJECT_ID">;

export interface ProjectSnapshot {
    exportedAt: string;
    backend: LegendKeeperClient["backend"];
    resources: Array<{
        resource: Resource;
        /** Page block trees, keyed by document id. */
        pages: Record<string, DocumentBlocks>;
        /** Map features, keyed by document id. */
        maps: Record<string, MapFeature[]>;
        /** Timeline lanes and events, keyed by document id. */
        timelines: Record<string, { lanes: TimelineLane[]; events: TimelineEvent[] }>;
    }>;
    /** Reads that failed; the rest of the snapshot is still written. */
    errors: string[];
}

export async function runNightlyBackup(env: BackupEnv): Promise<void> {
    const snapshot = await exportProject(createLegendKeeperClient(env));

    const key = `${KEY_PREFIX}${snapshot.exportedAt.slice(0, 10)}.json`;
    await env.BACKUPS.put(key, JSON.stringify(snapshot));
    if (snapshot.errors.length) {
        console.error(`Backup ${key} written with ${snapshot.errors.length} failed reads`, snapshot.errors);
    }

    await pruneOldSnapshots(env);
}

async function exportProject(lk: LegendKeeperClient): Promise<ProjectSnapshot> {
    const snapshot: ProjectSnapshot = {
        exportedAt: new Date().toISOString(),
        backend: lk.backend,
        resources: [],
        errors: [],
    };

    const throttled = async <T>(label: string, read: () => Promise<T>): Promise<T | undefined> => {
        await new Promise((resolve) => setTimeout(resolve, REQUEST_SPACING_MS));
        try {
            return await read();
        } catch (err) {
            snapshot.errors.push(`${label}: ${err instanceof Error ? err.message : String(err)}`);
            return undefined;
        }
    };

    // Listing failing is fatal: an empty snapshot must not look like a good one.
    const listed = await lk.listResources();

    for (const item of listed) {
        const resource = await throttled(`resource ${item.id}`, () => lk.getResource(item.id));
        if (!resource) continue;
        const entry: ProjectSnapshot["resources"][number] = { resource, pages: {}, maps: {}, timelines: {} };
        for (const doc of resource.documents) {
            const where = `${item.id}/${doc.id}`;
            if (doc.type === "page") {
                const blocks = await throttled(`page ${where}`, () => lk.getDocumentBlocks(item.id, doc.id));
                if (blocks) entry.pages[doc.id] = blocks;
            } else if (doc.type === "map") {
                const features = await throttled(`map ${where}`, () => lk.listMapFeatures(item.id, doc.id));
                if (features) entry.maps[doc.id] = features;
            } else if (doc.type === "time") {
                const lanes = await throttled(`timeline lanes ${where}`, () =>
                    lk.listTimelineLanes(item.id, doc.id),
                );
                const events = await throttled(`timeline events ${where}`, () =>
                    lk.listTimelineEvents(item.id, doc.id),
                );
                if (lanes && events) entry.timelines[doc.id] = { lanes, events };
            }
        }
        snapshot.resources.push(entry);
    }

    return snapshot;
}

async function pruneOldSnapshots(env: BackupEnv): Promise<void> {
    const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
    const listed = await env.BACKUPS.list({ prefix: KEY_PREFIX });

    await Promise.all(
        listed.objects
            .filter((object) => object.uploaded.getTime() < cutoff)
            .map((object) => env.BACKUPS.delete(object.key)),
    );
}
