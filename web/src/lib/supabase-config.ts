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
