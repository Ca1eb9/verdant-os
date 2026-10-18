"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { createRequestAuthClient, isAuthOutage, LOGIN_PATH, safeNextPath } from "@/lib/auth";

export interface SignInState {
  error: string | null;
  /** echoed back so the field keeps its value after a failed attempt */
  email: string;
}

// Supabase Auth's own limits are far below these; anything longer is not a login
const MAX_EMAIL_LENGTH = 320;
const MAX_PASSWORD_LENGTH = 1024;

const UNREACHABLE = "Can't reach the sign-in service right now. Try again in a moment.";

// Supabase Auth error codes, in plain words; anything else is logged
const SIGN_IN_ERRORS: Record<string, string> = {
  invalid_credentials: "Wrong email or password.",
  email_not_confirmed: "This account hasn't been confirmed yet. Ask whoever manages the farm's accounts.",
  user_banned: "This account has been turned off. Ask whoever manages the farm's accounts.",
  over_request_rate_limit: "Too many sign-in attempts. Wait a few minutes and try again.",
};

/**
 * Runs on the server: the password goes from the browser to this app and on
 * to Supabase Auth over HTTPS, and is never stored or logged here.
 */
export async function signIn(_prev: SignInState, formData: FormData): Promise<SignInState> {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  if (!email || !password) return { error: "Enter your email and password.", email };
  if (email.length > MAX_EMAIL_LENGTH || password.length > MAX_PASSWORD_LENGTH) {
    return { error: "Wrong email or password.", email: email.slice(0, MAX_EMAIL_LENGTH) };
  }

  const supabase = await createRequestAuthClient();
  if (!supabase) {
    console.error("[auth] sign-in needs SUPABASE_URL and SUPABASE_ANON_KEY (docs/SUPABASE-SETUP.md)");
    return { error: "Sign-in isn't set up on this server yet.", email };
  }

  try {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      const known = error.code ? SIGN_IN_ERRORS[error.code] : undefined;
      if (known) return { error: known, email };
      if (error.status === 429) return { error: SIGN_IN_ERRORS.over_request_rate_limit, email };
      console.error(`[auth] sign-in failed: ${error.status ?? "-"} ${error.code ?? "-"} ${error.message}`);
      return { error: isAuthOutage(error) ? UNREACHABLE : "Couldn't sign in. Try again.", email };
    }
  } catch (error) {
    console.error("[auth] sign-in failed", error);
    return { error: UNREACHABLE, email };
  }

  redirect(safeNextPath(formData.get("next")));
}

export async function signOut() {
  try {
    const supabase = await createRequestAuthClient();
    // this device only: signing out on a phone leaves the desk computer signed in
    await supabase?.auth.signOut({ scope: "local" });
  } catch (error) {
    console.error("[auth] sign-out call failed; clearing the session cookies anyway", error);
  }
  // drop the session cookies even when the sign-out call failed
  const cookieStore = await cookies();
  cookieStore
    .getAll()
    .filter(({ name }) => name.startsWith("sb-"))
    .forEach(({ name }) => cookieStore.delete(name));
  redirect(LOGIN_PATH);
}
