/**
 * GitHub OAuth handler — the OAuthProvider's `defaultHandler`. Ported from
 * Cloudflare's remote-mcp-github-oauth reference (fetched 2026-07-08), with
 * one deliberate change: `/callback` hard-rejects any GitHub account other
 * than ALLOWED_GITHUB_LOGIN before completeAuthorization is ever called, so
 * no token is issued and no tool is ever visible to anyone but Connor. The
 * campaign data behind this server is spoiler-sensitive, not just
 * mutation-risky — this is stricter than the reference's "authenticate
 * anyone, hide extra tools" pattern.
 */

import type { AuthRequest, OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { Hono } from "hono";
import { Octokit } from "octokit";

import type { Env } from "../env";
import { fetchUpstreamAuthToken, getUpstreamAuthorizeUrl, type Props } from "./upstream";
import {
    addApprovedClient,
    bindStateToSession,
    createOAuthState,
    generateCSRFProtection,
    isClientApproved,
    OAuthError,
    renderApprovalDialog,
    validateCSRFToken,
    validateOAuthState,
} from "./oauth-utils";

/** The one GitHub account this server will ever issue a token to. */
const ALLOWED_GITHUB_LOGIN = "Kishotta";

const app = new Hono<{ Bindings: Env & { OAUTH_PROVIDER: OAuthHelpers } }>();

app.get("/authorize", async (c) => {
    const oauthReqInfo = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw);
    const { clientId } = oauthReqInfo;
    if (!clientId) {
        return c.text("Invalid request", 400);
    }

    if (await isClientApproved(c.req.raw, clientId, c.env.COOKIE_ENCRYPTION_KEY)) {
        const { stateToken } = await createOAuthState(oauthReqInfo, c.env.OAUTH_KV);
        const { setCookie: sessionBindingCookie } = await bindStateToSession(stateToken);
        return redirectToGithub(c.req.raw, c.env.GITHUB_CLIENT_ID, stateToken, {
            "Set-Cookie": sessionBindingCookie,
        });
    }

    const { token: csrfToken, setCookie } = generateCSRFProtection();

    return renderApprovalDialog(c.req.raw, {
        client: await c.env.OAUTH_PROVIDER.lookupClient(clientId),
        csrfToken,
        server: {
            description:
                "Bespoke MCP server for The Convergence Gambit's LegendKeeper wiki. Single-tenant — only Connor's GitHub account is ever granted access.",
            name: "The Convergence Gambit MCP Server",
        },
        setCookie,
        state: { oauthReqInfo },
    });
});

app.post("/authorize", async (c) => {
    try {
        const formData = await c.req.raw.formData();

        validateCSRFToken(formData, c.req.raw);

        const encodedState = formData.get("state");
        if (!encodedState || typeof encodedState !== "string") {
            return c.text("Missing state in form data", 400);
        }

        let state: { oauthReqInfo?: AuthRequest };
        try {
            state = JSON.parse(atob(encodedState));
        } catch (_e) {
            return c.text("Invalid state data", 400);
        }

        if (!state.oauthReqInfo || !state.oauthReqInfo.clientId) {
            return c.text("Invalid request", 400);
        }

        const approvedClientCookie = await addApprovedClient(
            c.req.raw,
            state.oauthReqInfo.clientId,
            c.env.COOKIE_ENCRYPTION_KEY,
        );

        const { stateToken } = await createOAuthState(state.oauthReqInfo, c.env.OAUTH_KV);
        const { setCookie: sessionBindingCookie } = await bindStateToSession(stateToken);

        const headers = new Headers();
        headers.append("Set-Cookie", approvedClientCookie);
        headers.append("Set-Cookie", sessionBindingCookie);

        return redirectToGithub(
            c.req.raw,
            c.env.GITHUB_CLIENT_ID,
            stateToken,
            Object.fromEntries(headers),
        );
    } catch (error: any) {
        console.error("POST /authorize error:", error);
        if (error instanceof OAuthError) {
            return error.toResponse();
        }
        return c.text(`Internal server error: ${error.message}`, 500);
    }
});

async function redirectToGithub(
    request: Request,
    githubClientId: string,
    stateToken: string,
    headers: Record<string, string> = {},
) {
    return new Response(null, {
        headers: {
            ...headers,
            location: getUpstreamAuthorizeUrl({
                client_id: githubClientId,
                redirect_uri: new URL("/callback", request.url).href,
                scope: "read:user",
                state: stateToken,
                upstream_url: "https://github.com/login/oauth/authorize",
            }),
        },
        status: 302,
    });
}

/**
 * OAuth callback endpoint.
 *
 * Exchanges the code for a GitHub access token, fetches the authenticated
 * user, and — if and only if that user is ALLOWED_GITHUB_LOGIN — stores
 * login/name as `props` on the token via completeAuthorization. Any other
 * GitHub account gets a 403 here; no token is issued, no tool is ever
 * registered for them.
 *
 * SECURITY: validates that the state parameter from GitHub matches both a
 * valid state token in KV (proves it was created by our server) and the
 * __Host-CONSENTED_STATE cookie (proves this browser consented to it),
 * preventing CSRF attacks where an attacker's state token is injected into
 * a victim's OAuth flow.
 */
app.get("/callback", async (c) => {
    let oauthReqInfo: AuthRequest;
    let clearSessionCookie: string;

    try {
        const result = await validateOAuthState(c.req.raw, c.env.OAUTH_KV);
        oauthReqInfo = result.oauthReqInfo;
        clearSessionCookie = result.clearCookie;
    } catch (error: any) {
        if (error instanceof OAuthError) {
            return error.toResponse();
        }
        return c.text("Internal server error", 500);
    }

    if (!oauthReqInfo.clientId) {
        return c.text("Invalid OAuth request data", 400);
    }

    const [accessToken, errResponse] = await fetchUpstreamAuthToken({
        client_id: c.env.GITHUB_CLIENT_ID,
        client_secret: c.env.GITHUB_CLIENT_SECRET,
        code: c.req.query("code"),
        redirect_uri: new URL("/callback", c.req.url).href,
        upstream_url: "https://github.com/login/oauth/access_token",
    });
    if (errResponse) return errResponse;

    const user = await new Octokit({ auth: accessToken }).rest.users.getAuthenticated();
    const { login, name } = user.data;

    if (login !== ALLOWED_GITHUB_LOGIN) {
        return c.text("This MCP server is private. Your GitHub account is not authorized.", 403);
    }

    const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
        metadata: { label: name ?? login },
        // Available on this.props inside ConvergenceGambitMCP.
        props: { login, name: name ?? login } satisfies Props,
        request: oauthReqInfo,
        scope: oauthReqInfo.scope,
        userId: login,
    });

    const headers = new Headers({ Location: redirectTo });
    if (clearSessionCookie) {
        headers.set("Set-Cookie", clearSessionCookie);
    }

    return new Response(null, { status: 302, headers });
});

app.notFound((c) =>
    c.text(
        "The Convergence Gambit MCP server. Nothing is true until you tell the players.",
        404,
    ),
);

export { app as GitHubHandler };
