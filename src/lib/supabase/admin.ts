import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { SupabaseNotConfiguredError } from "@/lib/supabase/env";

/*
 * Service-role client. Bypasses RLS, so it is server only: use it for writes after the caller's
 * session and role were checked, and for reads the user's own JWT may not see (console, slug checks).
 * The `server-only` package is not installed, so this guard fails loudly if a client bundle imports it.
 */
if (typeof window !== "undefined") {
  throw new Error("src/lib/supabase/admin.ts is server only. Browser code reads through /api routes and server components.");
}

let cached: SupabaseClient | null = null;

export function isAdminConfigured(): boolean {
  return Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

export function createAdminClient(): SupabaseClient {
  if (cached) return cached;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    throw new SupabaseNotConfiguredError("Supabase is not configured on the server. Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (see docs/SETUP.md).");
  }
  cached = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  return cached;
}
