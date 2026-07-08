/**
 * Nightly backup export — walking-skeleton stub.
 *
 * Fires on the cron trigger configured in wrangler.jsonc. Calls the
 * `LegendKeeperClient.exportProject()` seam (SPEC-DRIFT CRITICAL UNKNOWN
 * #3 — see src/lk/types.ts) and writes the result to R2 as one object per
 * night, then prunes anything older than RETENTION_DAYS.
 *
 * Backed by the fake client today, so the storage + retention path is
 * proven end-to-end even though the real export endpoint doesn't exist
 * yet. When src/lk/http.ts ships and exportProject() is confirmed against
 * the real API, nothing here needs to change — only src/lk/client.ts does.
 */

import { createLegendKeeperClient } from "./lk/client";

const RETENTION_DAYS = 30;
const KEY_PREFIX = "snapshots/";

export interface BackupEnv {
    BACKUPS: R2Bucket;
}

export async function runNightlyBackup(env: BackupEnv): Promise<void> {
    const lk = createLegendKeeperClient();
    const snapshot = await lk.exportProject();

    const key = `${KEY_PREFIX}${snapshot.exportedAt.slice(0, 10)}.json`;
    await env.BACKUPS.put(key, JSON.stringify(snapshot));

    await pruneOldSnapshots(env);
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
