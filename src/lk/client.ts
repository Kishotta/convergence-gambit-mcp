/**
 * Single construction point for the LegendKeeperClient seam.
 *
 * Both the MCP tools (src/index.ts) and the nightly backup cron
 * (src/backup.ts) get their client from here.
 *
 * With `LK_API_KEY` set, the client reads the live project through the
 * SDK. Without it, the in-memory fake answers instead, so `npm run dev`
 * works without a key. The `ping` tool reports which backend is answering,
 * so a deploy missing the secret is visible rather than silently fake.
 */

import type { Env } from "../env";
import { FakeLegendKeeperClient } from "./fake";
import { SdkLegendKeeperClient } from "./sdk";
import type { LegendKeeperClient } from "./types";

export function createLegendKeeperClient(
    env: Pick<Env, "LK_API_KEY" | "LK_PROJECT_ID">,
): LegendKeeperClient {
    if (env.LK_API_KEY) {
        return new SdkLegendKeeperClient(env.LK_API_KEY, env.LK_PROJECT_ID || undefined);
    }
    return new FakeLegendKeeperClient();
}
