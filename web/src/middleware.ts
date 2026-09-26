import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { AUTH_COOKIE_OPTIONS, authDisabled, getSupabaseAuthConfig } from "@/lib/supabase-config";

/**
 * On the Pi, only answer to LAN-style host names: IP addresses, localhost,
 * single-label names, .local / .lan / .home.arpa, or anything in LOCAL_HOSTS.
 * A website can't then point its own domain at the Pi (DNS rebinding) and
 * read the dashboard through a visitor's browser.
 */
function isLanHost(host: string | null) {
  if (!host) return false;
  const name = host.toLowerCase().replace(/:\d+$/, "");
  const extra = (process.env.LOCAL_HOSTS ?? "").toLowerCase().split(",").map((h) => h.trim());
  return (
    extra.includes(name) ||
    name === "localhost" ||
    name.startsWith("[") || // IPv6 literal
    /^\d{1,3}(\.\d{1,3}){3}$/.test(name) ||
    !name.includes(".") ||
    /\.(local|lan|home\.arpa)$/.test(name)
  );
}

// Every page and API route needs a signed-in operator, except on the Pi (AUTH_DISABLED).
export async function middleware(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const onLogin = pathname === "/login";
  if (authDisabled()) {
    if (!isLanHost(request.headers.get("host"))) {
      return new NextResponse("Unknown host. Add it to LOCAL_HOSTS to allow it.", { status: 403 });
    }
    return onLogin ? NextResponse.redirect(new URL("/", request.url)) : NextResponse.next();
  }

  let response = NextResponse.next({ request });
  let signedIn = false;

  const { url, anonKey } = getSupabaseAuthConfig();
  if (url && anonKey) {
    const supabase = createServerClient(url, anonKey, {
      cookieOptions: AUTH_COOKIE_OPTIONS,
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
        },
      },
    });

    try {
      // getUser() also refreshes an expired access token and rewrites the cookies
      const { data } = await supabase.auth.getUser();
      signedIn = Boolean(data.user);
    } catch {
      // Supabase unreachable: fail closed
    }
  }

  const redirect = (to: URL) => {
    const next = NextResponse.redirect(to);
    response.cookies.getAll().forEach((cookie) => next.cookies.set(cookie));
    return next;
  };

  if (signedIn) {
    return onLogin ? redirect(new URL("/", request.url)) : response;
  }
  if (onLogin) return response;
  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  }

  const login = new URL("/login", request.url);
  login.searchParams.set("next", pathname + search);
  return redirect(login);
}

export const config = {
  // skip static files so the login page, icons and PWA manifest load signed out
  matcher: ["/((?!_next/static|images/|favicon.ico|manifest.webmanifest|service-worker.js).*)"],
};
