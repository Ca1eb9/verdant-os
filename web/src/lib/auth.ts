import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { createServerClient, type CookieMethodsServer } from "@supabase/ssr";
import { isAuthRetryableFetchError, type AuthError } from "@supabase/supabase-js";
import { getSupabaseAuthConfig } from "@/lib/supabase-config";

export const LOGIN_PATH = "/login";

// A hung Supabase Auth fails here instead of holding every page until the platform times out
const AUTH_TIMEOUT_MS = 8_000;

/**
 * Session cookies. httpOnly: nothing in the browser reads them (sign-in and
 * sign-out run on the server), so an injected script can't steal a session.
 * @supabase/ssr keeps its 400-day maxAge, and the middleware refreshes the
 * short-lived access token on every request, so operators stay signed in.
 */
const AUTH_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax",
} as const;

/**
 * Whether the dashboard asks operators to sign in. Never on a farm's Pi: its
 * build talks to the broker on FarmNet (NEXT_PUBLIC_MQTT_WS_URL, the same
 * switch as ON_FARMNET in lib/farm/data-source.ts) and has to keep working
 * with no internet. Everywhere else, Vercel included, unless AUTH_DISABLED is
 * "true". Vercel is never treated as FarmNet, so a stray MQTT URL there can't
 * open the dashboard.
 */
export function signInRequired() {
  if (process.env.NEXT_PUBLIC_MQTT_WS_URL && !process.env.VERCEL) return false;
  return process.env.AUTH_DISABLED?.trim().toLowerCase() !== "true";
}

export type Session =
  | { state: "signed-in"; email: string }
  | { state: "signed-out" }
  /** Supabase Auth didn't answer, or failed: the operator may well be signed in */
  | { state: "unavailable" }
  /** No Supabase URL or publishable key on this server: nobody can sign in */
  | { state: "unconfigured" };

export type SessionProblem = "unavailable" | "unconfigured";

const timedFetch: typeof fetch = (input, init) =>
  fetch(input, { ...init, signal: init?.signal ?? AbortSignal.timeout(AUTH_TIMEOUT_MS) });

/** Supabase Auth over the request's session cookies; null when this server has no Supabase keys */
export function createAuthClient(cookieMethods: CookieMethodsServer) {
  const { url, anonKey } = getSupabaseAuthConfig();
  if (!url || !anonKey) return null;
  return createServerClient(url, anonKey, {
    cookieOptions: AUTH_COOKIE_OPTIONS,
    cookies: cookieMethods,
    global: { fetch: timedFetch },
  });
}

/** For server components, server actions and route handlers */
export async function createRequestAuthClient() {
  const cookieStore = await cookies();
  return createAuthClient({
    getAll: () => cookieStore.getAll(),
    setAll(cookiesToSet) {
      try {
        cookiesToSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options));
      } catch {
        // server components can't set cookies; the middleware already refreshed them
      }
    },
  });
}

/** Supabase Auth unreachable, timed out or failing, as opposed to refusing the session */
export function isAuthOutage(error: AuthError) {
  return isAuthRetryableFetchError(error) || (error.status ?? 0) >= 500;
}

/**
 * Checks the session in the cookies. getClaims() verifies the access token
 * against the project's signing keys (cached, so usually no request) and
 * refreshes it first when it's about to expire, rewriting the cookies.
 */
export async function readSession(supabase: ReturnType<typeof createAuthClient>): Promise<Session> {
  if (!supabase) {
    console.error("[auth] sign-in needs SUPABASE_URL and SUPABASE_ANON_KEY (docs/SUPABASE-SETUP.md)");
    return { state: "unconfigured" };
  }
  try {
    const { data, error } = await supabase.auth.getClaims();
    if (data?.claims) return { state: "signed-in", email: data.claims.email ?? data.claims.sub };
    if (error && isAuthOutage(error)) {
      console.error(`[auth] Supabase Auth unavailable: ${error.message}`);
      return { state: "unavailable" };
    }
    return { state: "signed-out" };
  } catch (error) {
    console.error("[auth] session check failed", error);
    return { state: "unavailable" };
  }
}

/** The request's session; null where sign-in is off (FarmNet, AUTH_DISABLED) */
export async function getSession(): Promise<Session | null> {
  // no Supabase call at all when sign-in is off, so a Pi works offline
  if (!signInRequired()) return null;
  return readSession(await createRequestAuthClient());
}

const REFUSALS: Record<Exclude<Session["state"], "signed-in">, [number, string]> = {
  "signed-out": [401, "You're signed out. Reload the page to sign in again."],
  unavailable: [503, "Can't reach the sign-in service right now. Try again in a moment."],
  unconfigured: [503, "Sign-in isn't set up on this server yet."],
};

/** For API routes: the response refusing a request without a signed-in operator, or null to go ahead */
export function refuse(session: Session | null) {
  if (!session || session.state === "signed-in") return null;
  const [status, error] = REFUSALS[session.state];
  return NextResponse.json({ error }, { status });
}

/**
 * Where to go after signing in: only a path on this site, so ?next= can't send
 * anyone elsewhere. Parsing resolves every trick a browser would (//host,
 * /\host, tabs, other schemes) before the origin is compared.
 */
export function safeNextPath(value: unknown) {
  if (typeof value !== "string" || !value) return "/";
  try {
    const url = new URL(value, "http://local");
    return url.origin === "http://local" && url.pathname !== LOGIN_PATH ? url.pathname + url.search : "/";
  } catch {
    return "/";
  }
}
