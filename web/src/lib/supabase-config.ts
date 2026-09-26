function firstValue(...values: Array<string | undefined>) {
  return values.find((value) => value && value.trim().length > 0) ?? null;
}

export function getSupabaseReadConfig() {
  return {
    url: firstValue(
      process.env.SUPABASE_URL,
      process.env.NEXT_PUBLIC_SUPABASE_URL,
    ),
    key: firstValue(
      process.env.SUPABASE_SERVICE_ROLE_KEY,
      process.env.SUPABASE_ANON_KEY,
      process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    ),
    hasServiceRoleKey: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY),
  };
}

/** Keys for Supabase Auth. Never the service role key: sign-in runs as the user. */
export function getSupabaseAuthConfig() {
  return {
    url: firstValue(process.env.SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_URL),
    anonKey: firstValue(process.env.SUPABASE_ANON_KEY, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY),
  };
}

/**
 * Set AUTH_DISABLED=true only on the farm's Pi. The LAN is already behind the
 * WiFi password, and the Pi must keep working with no internet, so it skips
 * Supabase Auth entirely. Never set it on Vercel.
 */
export function authDisabled() {
  return process.env.AUTH_DISABLED === "true";
}
