"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { createAuthClient } from "@/lib/auth";

export interface SignInState {
  error: string | null;
  /** echoed back so the field keeps its value after a failed attempt */
  email: string;
}

/** Only same-site paths, so ?next= can't send someone to another site */
function safeNext(value: FormDataEntryValue | null) {
  return typeof value === "string" && value.startsWith("/") && !value.startsWith("//") ? value : "/";
}

const UNREACHABLE = "Can't reach the sign-in service. Check the connection and try again.";

export async function signIn(_prev: SignInState, formData: FormData): Promise<SignInState> {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  if (!email || !password) return { error: "Enter your email and password.", email };

  const supabase = await createAuthClient();
  if (!supabase) return { error: "Sign-in isn't configured on this server.", email };

  try {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error?.code === "invalid_credentials") return { error: "Wrong email or password.", email };
    // 4xx carry a readable reason (e.g. rate limited); anything else means Supabase is unreachable
    if (error) return { error: error.status && error.status < 500 ? error.message : UNREACHABLE, email };
  } catch {
    return { error: UNREACHABLE, email };
  }

  redirect(safeNext(formData.get("next")));
}

export async function signOut() {
  try {
    const supabase = await createAuthClient();
    await supabase?.auth.signOut();
  } catch {
    // Supabase unreachable: the cookies are still cleared below
  }
  // drop the session cookies even when the sign-out call failed
  const cookieStore = await cookies();
  cookieStore
    .getAll()
    .filter(({ name }) => name.startsWith("sb-"))
    .forEach(({ name }) => cookieStore.delete(name));
  redirect("/login");
}
