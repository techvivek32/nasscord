import { NextResponse, type NextRequest } from "next/server";
import { createServerClient, type CookieOptions } from "@supabase/ssr";
import type { JwtPayload } from "@supabase/supabase-js";
import { supabasePublicEnv } from "@/lib/supabase/env";

export interface ProxySession {
  /** Pass-through response carrying refreshed auth cookies and the forwarded request headers. */
  response: NextResponse;
  /** Verified JWT claims, or null when signed out (or Supabase is not configured). */
  claims: JwtPayload | null;
  /** Copies refreshed auth cookies onto another response, e.g. a redirect, so a refresh is never lost. */
  carry: (res: NextResponse) => NextResponse;
}

type PendingCookie = { name: string; value: string; options: CookieOptions };

/**
 * Refreshes the Supabase session for this request and returns verified claims.
 * `decorate` edits the headers forwarded to the app (x-workspace / x-tenant); it runs again after a
 * refresh so the forwarded Cookie header holds the new tokens for the server components of this request.
 * getClaims() verifies the JWT (locally with the project's JWKS, or against Auth for symmetric keys),
 * so the role read from app_metadata can be trusted.
 */
export async function updateSession(request: NextRequest, decorate: (headers: Headers) => void): Promise<ProxySession> {
  const forward = () => {
    const headers = new Headers(request.headers);
    decorate(headers);
    return NextResponse.next({ request: { headers } });
  };

  let response = forward();
  const env = supabasePublicEnv();
  if (!env) return { response, claims: null, carry: (res) => res };

  let pending: PendingCookie[] = [];
  let pendingHeaders: Record<string, string> = {};

  const supabase = createServerClient(env.url, env.anonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet, headers) {
        for (const { name, value } of cookiesToSet) request.cookies.set(name, value);
        response = forward();
        for (const { name, value, options } of cookiesToSet) response.cookies.set(name, value, options);
        for (const [key, value] of Object.entries(headers ?? {})) response.headers.set(key, value);
        pending = cookiesToSet;
        pendingHeaders = headers ?? {};
      },
    },
  });

  let claims: JwtPayload | null = null;
  try {
    const { data } = await supabase.auth.getClaims();
    claims = data?.claims ?? null;
  } catch {
    // Auth unreachable or a malformed cookie: treat as signed out for this request.
    claims = null;
  }

  const carry = (res: NextResponse) => {
    for (const { name, value, options } of pending) res.cookies.set(name, value, options);
    for (const [key, value] of Object.entries(pendingHeaders)) res.headers.set(key, value);
    return res;
  };

  return { response, claims, carry };
}
