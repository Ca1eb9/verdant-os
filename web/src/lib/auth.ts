import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import { AUTH_COOKIE_OPTIONS, authDisabled, getSupabaseAuthConfig } from "@/lib/supabase-config";

export interface Operator {
  email: string;
  local: boolean;
}

const LOCAL_OPERATOR: Operator = { email: "local-dashboard", local: true };

/**
 * Supabase client that reads and writes the session cookies. Sessions last
 * well past two weeks: @supabase/ssr keeps the cookies for 400 days and the
 * middleware refreshes the short-lived access token on every request. Keep
 * Supabase's "time-box" / "inactivity timeout" session settings off (or at
 * 14 days or more) so the refresh token stays valid.
 */
export async function createAuthClient() {
  const { url, anonKey } = getSupabaseAuthConfig();
  if (!url || !anonKey) return null;
  const cookieStore = await cookies();

  return createServerClient(url, anonKey, {
    cookieOptions: AUTH_COOKIE_OPTIONS,
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options));
        } catch {
          // called from a server component, where cookies are read-only; the middleware refreshes them
        }
      },
    },
  });
}

/** The signed-in operator, the local operator on the Pi, or null */
export async function getOperator(): Promise<Operator | null> {
  // no Supabase calls at all on the Pi, so it works offline
  if (authDisabled()) return LOCAL_OPERATOR;

  try {
    const supabase = await createAuthClient();
    if (!supabase) return null;
    const { data } = await supabase.auth.getUser();
    return data.user ? { email: data.user.email ?? data.user.id, local: false } : null;
  } catch {
    // Supabase unreachable: treat as signed out
    return null;
  }
}

/**
 * True unless a browser says the request came from another site. Blocks
 * cross-site form posts, which matters most on the Pi where no cookie is
 * needed. Non-browser clients (curl, services) send neither header.
 */
export function sameOrigin(request: Request) {
  const source = request.headers.get("origin") ?? request.headers.get("referer");
  if (!source) return true;
  try {
    return new URL(source).host === request.headers.get("host");
  } catch {
    return false;
  }
}
