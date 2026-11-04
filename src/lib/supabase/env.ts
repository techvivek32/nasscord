/* ------------------------------------------------------------------
   Supabase settings. Pure: safe for the proxy, the server and the browser.
   NEXT_PUBLIC_* values are inlined at build time, so they are read with
   their literal names. Without them the public site still renders and the
   auth pages say that Supabase is not configured.
   ------------------------------------------------------------------ */

export interface SupabasePublicEnv {
  url: string;
  anonKey: string;
}

/** URL and anon key, or null when either is missing. */
export function supabasePublicEnv(): SupabasePublicEnv | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) return null;
  return { url, anonKey };
}

export function isSupabaseConfigured(): boolean {
  return supabasePublicEnv() !== null;
}

/** Shown wherever sign-in would need Supabase and the project is not set up. */
export const SUPABASE_NOT_CONFIGURED =
  "Supabase is not configured. Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY (see docs/SETUP.md).";

export class SupabaseNotConfiguredError extends Error {
  constructor(message = SUPABASE_NOT_CONFIGURED) {
    super(message);
    this.name = "SupabaseNotConfiguredError";
  }
}

/** Base URL for links in emails. Falls back to the request origin the caller passes. */
export function siteUrl(fallbackOrigin?: string): string {
  const raw = process.env.NEXT_PUBLIC_SITE_URL || fallbackOrigin || "http://localhost:3000";
  return raw.replace(/\/+$/, "");
}

const UNSAFE_PATH_CHARS = /[\u0000-\u001F\u007F\s\\]/;
const PATH_BASE = "http://nasscord.invalid";

/**
 * A relative in-app path, or null. Blocks open redirects: absolute and protocol-relative URLs, and any
 * value with control characters, whitespace or a backslash (URL parsers strip tabs and newlines and read
 * `\` as `/`, so "/\t/evil.com" would otherwise leave the site). What is returned is the path as the URL
 * parser resolved it against our own origin, so the browser lands exactly where we checked.
 */
export function safeNextPath(next: unknown): string | null {
  if (typeof next !== "string" || next.length > 2048 || !next.startsWith("/") || UNSAFE_PATH_CHARS.test(next)) return null;
  let url: URL;
  try {
    url = new URL(next, PATH_BASE);
  } catch {
    return null;
  }
  if (url.origin !== PATH_BASE) return null;
  const path = `${url.pathname}${url.search}${url.hash}`;
  // Dot segments can collapse to "//host" ("/.//evil.com" resolves to the path "//evil.com").
  return path.startsWith("/") && !path.startsWith("//") ? path : null;
}
