// The authentication port (PROTOCOL.md §7, opt-in).
//
// Connect-time only in v1: no mid-session refresh, no RBAC. When an Authenticator
// is configured, connect requires a valid credential and the verified `userId`
// overrides whatever the client asserted (anti-spoofing).

/** The credential a client presented at connect, from whichever channel carried it. */
export interface Credential {
    /** From `hello.token`, `?token=`, or an `Authorization: Bearer` header. */
    token?: string;
    /** Raw connect headers, for a cookie/session Authenticator. */
    headers?: Record<string, string | undefined>;
    /** Raw connect query params. */
    query?: Record<string, string | undefined>;
}

export interface AuthVerdict {
    ok: boolean;
    /** The authoritative user id on success - overrides the client-asserted one. */
    userId?: string;
    /** Verified claims; surfaced to nodes at `ctx.meta.auth`. */
    claims?: Record<string, unknown>;
    /** Human-readable rejection reason; sent in the `error{unauthorized}` frame. */
    reason?: string;
}

export interface Authenticator {
    authenticate(credential: Credential): Promise<AuthVerdict> | AuthVerdict;
}

/**
 * A minimal Authenticator: a fixed table of `token → {userId, claims}`. For
 * tests and simple deployments; real ones verify a JWT or a session cookie.
 */
export class StaticTokenAuthenticator implements Authenticator {
    private readonly table: ReadonlyMap<string, { userId: string; claims?: Record<string, unknown> }>;

    constructor(tokens: Record<string, { userId: string; claims?: Record<string, unknown> }>) {
        this.table = new Map(Object.entries(tokens));
    }

    authenticate(credential: Credential): AuthVerdict {
        const token = credential.token;
        if (token === undefined) return { ok: false, reason: "no token presented" };
        const hit = this.table.get(token);
        if (!hit) return { ok: false, reason: "invalid token" };
        return { ok: true, userId: hit.userId, ...(hit.claims ? { claims: hit.claims } : {}) };
    }
}
