import { headers } from "next/headers";
import { siteUrl } from "@/lib/supabase/env";

/* Facts about the current request for server actions and route handlers. Server only. */

if (typeof window !== "undefined") throw new Error("src/lib/server is server only.");

/** The client address (first X-Forwarded-For hop), or null outside a request. */
export async function requestIp(): Promise<string | null> {
  try {
    const h = await headers();
    const forwarded = h.get("x-forwarded-for")?.split(",")[0]?.trim();
    return forwarded || h.get("x-real-ip") || null;
  } catch {
    return null;
  }
}

/** Base URL for links in emails: NEXT_PUBLIC_SITE_URL, else this request's own origin. */
export async function emailLinkBase(): Promise<string> {
  try {
    const h = await headers();
    const host = h.get("x-forwarded-host") ?? h.get("host");
    const proto = h.get("x-forwarded-proto") ?? (host?.startsWith("localhost") ? "http" : "https");
    return siteUrl(host ? `${proto}://${host}` : undefined);
  } catch {
    return siteUrl();
  }
}
