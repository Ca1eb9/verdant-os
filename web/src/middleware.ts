import { NextResponse, type NextRequest } from "next/server";
import { createAuthClient, LOGIN_PATH, readSession, refuse, safeNextPath, signInRequired } from "@/lib/auth";

/**
 * Every page and API route needs a signed-in operator, except where sign-in
 * is off (a farm's Pi, or AUTH_DISABLED). Fails closed: with Supabase Auth
 * unreachable or unconfigured, nothing but the login page loads, and it says why.
 */
export async function middleware(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const onLogin = pathname === LOGIN_PATH;
  if (!signInRequired()) {
    return onLogin ? NextResponse.redirect(new URL("/", request.url)) : NextResponse.next();
  }

  let response = NextResponse.next({ request });
  const session = await readSession(
    createAuthClient({
      getAll: () => request.cookies.getAll(),
      // a refreshed or cleared session: pass it on to the page and back to the browser
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
      },
    }),
  );

  const redirect = (to: URL) => {
    const next = NextResponse.redirect(to);
    response.cookies.getAll().forEach((cookie) => next.cookies.set(cookie));
    return next;
  };

  if (session.state === "signed-in") {
    return onLogin ? redirect(new URL(safeNextPath(request.nextUrl.searchParams.get("next")), request.url)) : response;
  }
  if (onLogin) return response;
  if (pathname.startsWith("/api/")) return refuse(session) ?? response;

  const login = new URL(LOGIN_PATH, request.url);
  if (pathname !== "/" || search) login.searchParams.set("next", pathname + search);
  if (session.state === "unavailable") login.searchParams.set("reason", "unavailable");
  return redirect(login);
}

export const config = {
  // static files load signed out: the login page's fonts and icons, the PWA manifest and service worker
  matcher: ["/((?!_next/static|_next/image|images/|favicon.ico|manifest.webmanifest|service-worker.js).*)"],
};
