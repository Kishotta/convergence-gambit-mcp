/**
 * Single construction point for the LegendKeeperClient seam.
 *
 * Both the MCP tools (src/index.ts) and the nightly backup cron
 * (src/backup.ts) get their client from here, so cutover to the real HTTP
 * client (src/lk/http.ts, when it ships) stays a one-line change in this
 * file instead of one per call site.
 */

import { FakeLegendKeeperClient } from "./fake";
import type { LegendKeeperClient } from "./types";

export function createLegendKeeperClient(): LegendKeeperClient {
    return new FakeLegendKeeperClient();
}
