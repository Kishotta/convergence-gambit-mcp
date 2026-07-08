/**
 * The Convergence Gambit MCP server — walking skeleton.
 *
 * Bespoke, single-tenant, two clients (Connor and Claude). The design
 * philosophy is baked into source, not configuration: this server exists
 * to make LegendKeeper article work follow the architecture charter.
 *
 * Skeleton toolset:
 *   - ping            proves the transport
 *   - get_charter     serves the architecture charter verbatim
 *   - list_resources  proves the LegendKeeperClient seam (fake-backed today)
 *   - get_resource    proves parameterized reads through the seam
 *
 * SECURITY NOTE: this skeleton is intentionally authless and holds no
 * LegendKeeper API key. Do not add LK_API_KEY as a secret until OAuth is
 * in place (see README, phase 2).
 */

import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { ARCHITECTURE_CHARTER } from "./charter";
import { FakeLegendKeeperClient } from "./lk/fake";
import type { LegendKeeperClient } from "./lk/types";

interface Env {
  MCP_OBJECT: DurableObjectNamespace;
  // Phase 2, after OAuth: LK_API_KEY: string; LK_PROJECT_ID: string;
}

export class ConvergenceGambitMCP extends McpAgent<Env> {
  server = new McpServer({
    name: "The Convergence Gambit",
    version: "0.1.0",
  });

  /**
   * The seam. Swap FakeLegendKeeperClient for the real HTTP client when
   * the API ships; every tool above this line is untouched at cutover.
   */
  private lk: LegendKeeperClient = new FakeLegendKeeperClient();

  async init() {
    this.server.tool(
      "ping",
      "Health check. Returns a signature line proving the Convergence Gambit MCP server is alive.",
      {},
      async () => text("The Lady's shadow falls across the skeleton, and it walks. (pong)"),
    );

    this.server.tool(
      "get_charter",
      "Returns the LegendKeeper Architecture & Presentation Charter — the authoritative " +
        "conventions for how Convergence Gambit wiki articles are organized, layered for " +
        "two audiences, and written. Consult before creating or restructuring any article.",
      {},
      async () => text(ARCHITECTURE_CHARTER),
    );

    this.server.tool(
      "list_resources",
      "Lists all wiki articles (LegendKeeper resources) in the Convergence Gambit project: " +
        "id, name, parent, tags, aliases. Currently backed by an in-memory fake with seed data.",
      {},
      async () => json(await this.lk.listResources()),
    );

    this.server.tool(
      "get_resource",
      "Fetches a single wiki article by resource id, including its document tabs.",
      { resourceId: z.string().describe("The resource id, e.g. res_101") },
      async ({ resourceId }) => {
        try {
          return json(await this.lk.getResource(resourceId));
        } catch (err) {
          return text(`Error: ${err instanceof Error ? err.message : String(err)}`, true);
        }
      },
    );
  }
}

function text(body: string, isError = false) {
  return { content: [{ type: "text" as const, text: body }], isError };
}

function json(value: unknown) {
  return text(JSON.stringify(value, null, 2));
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const { pathname } = new URL(request.url);

    // Streamable HTTP — what Claude's custom connectors speak.
    if (pathname === "/mcp") {
      return ConvergenceGambitMCP.serve("/mcp").fetch(request, env, ctx);
    }
    // Legacy SSE transport, kept for MCP Inspector compatibility.
    if (pathname === "/sse" || pathname === "/sse/message") {
      return ConvergenceGambitMCP.serveSSE("/sse").fetch(request, env, ctx);
    }

    return new Response(
      "The Convergence Gambit MCP server. Nothing is true until you tell the players.",
      { status: 404 },
    );
  },
};
