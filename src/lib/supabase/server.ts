import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import { SupabaseNotConfiguredError, supabasePublicEnv } from "@/lib/supabase/env";

/**
 * Supabase client for server components, server actions and route handlers. It acts as the signed-in
 * user (their JWT from the auth cookies), so every read goes through RLS. Create one per request.
 *
 * Server components cannot write cookies; a token refresh there is dropped silently and the proxy
 * (src/proxy.ts) refreshes the session on the next request instead. Server actions and route
 * handlers can write cookies, so a refresh or sign-in there is persisted.
 */
export async function createClient() {
  const env = supabasePublicEnv();
  if (!env) throw new SupabaseNotConfiguredError();
  const cookieStore = await cookies();

  return createServerClient(env.url, env.anonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) cookieStore.set(name, value, options);
        } catch {
          // Called from a server component: cookies are read-only there. The proxy refreshes the session.
        }
      },
    },
  });
}
