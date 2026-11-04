"use server";

import { z } from "zod";
import { createAdminClient, isAdminConfigured } from "@/lib/supabase/admin";
import { audit } from "@/lib/server/audit";
import { rateLimit } from "@/lib/server/rate-limit";
import { requestIp } from "@/lib/server/request";
import type { ActionResult } from "@/lib/signup";

/*
 * Forms on the public site. No sign-in: input is validated with zod, each address is rate limited
 * in memory, and rows are inserted with the service role (the tables have no insert policy).
 */

const NOT_READY = "Submissions are not open on this server yet. Try again later.";
const TOO_MANY = "Too many submissions from your network. Try again in a few minutes.";

async function allowed(kind: string, limit: number): Promise<boolean> {
  const ip = (await requestIp()) ?? "unknown";
  return rateLimit(`${kind}:${ip}`, limit, 10 * 60_000);
}

const applicationSchema = z.object({
  name: z.string().trim().min(2, "Enter your name.").max(80, "Keep it under 80 characters."),
  company: z.string().trim().min(2, "Enter your company or brand.").max(80, "Keep it under 80 characters."),
  email: z.email("Enter a valid work email."),
  offer: z.enum(["commission", "white_label"], { error: "Choose commission or white-label." }),
  expectedTraders: z.number().int("Whole numbers only.").min(1, "At least 1 trader.").max(100_000, "Talk to us directly for more than 100,000 traders.").optional(),
  notes: z.string().trim().max(1000, "Keep notes under 1,000 characters.").optional(),
});
export type TenantApplicationInput = z.input<typeof applicationSchema>;

/** Saves an application to become a tenant (public.tenant_applications). */
export async function submitTenantApplication(input: TenantApplicationInput): Promise<ActionResult> {
  const parsed = applicationSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, error: issue?.message ?? "Check the form and try again.", field: issue?.path[0]?.toString() };
  }
  if (!isAdminConfigured()) return { ok: false, error: NOT_READY };
  if (!(await allowed("tenant-application", 3))) return { ok: false, error: TOO_MANY };
  const v = parsed.data;
  const { error } = await createAdminClient()
    .from("tenant_applications")
    .insert({
      name: v.name,
      company: v.company,
      email: v.email.toLowerCase(),
      offer: v.offer,
      expected_traders: v.expectedTraders ?? null,
      notes: v.notes ? v.notes : null,
    });
  if (error) return { ok: false, error: "We could not save your application. Try again in a moment." };
  // Anonymous form: the typed address is not verified, so it is recorded as data, never as the actor.
  await audit({ actorEmail: null, action: "tenant.application.submit", target: v.company, meta: { offer: v.offer, contact_email: v.email.toLowerCase() } });
  return { ok: true };
}

const brokerRequestSchema = z.object({
  brokerName: z.string().trim().min(2, "Enter the broker's name.").max(80, "Keep it under 80 characters."),
  email: z.email("Enter a valid email so we can tell you when it is ready."),
});
export type BrokerRequestInput = z.input<typeof brokerRequestSchema>;

/** Saves a request to support another broker (public.broker_requests). */
export async function submitBrokerRequest(input: BrokerRequestInput): Promise<ActionResult> {
  const parsed = brokerRequestSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, error: issue?.message ?? "Check the form and try again.", field: issue?.path[0]?.toString() };
  }
  if (!isAdminConfigured()) return { ok: false, error: NOT_READY };
  if (!(await allowed("broker-request", 5))) return { ok: false, error: TOO_MANY };
  const { error } = await createAdminClient()
    .from("broker_requests")
    .insert({ broker_name: parsed.data.brokerName, email: parsed.data.email.toLowerCase() });
  if (error) return { ok: false, error: "We could not save your request. Try again in a moment." };
  return { ok: true };
}
