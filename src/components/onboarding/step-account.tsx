"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { ChevronDownIcon, EyeIcon, EyeOffIcon, HandshakeIcon, LoaderCircleIcon, MailCheckIcon, TriangleAlertIcon } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group";
import { Label } from "@/components/ui/label";
import { lookupTenantCode, resendConfirmation, signUpAccount } from "@/lib/auth-actions";
import { maskEmail } from "@/lib/format";
import { cn } from "@/lib/utils";
import { PasswordStrength } from "@/components/onboarding/password-strength";
import { accountSchema, type AccountValues } from "@/components/onboarding/schemas";
import { FieldError, FieldHint, StepShell, useFocusOnMount } from "@/components/onboarding/step-shell";
import { useSignupStore } from "@/components/onboarding/store";

/**
 * Step 1: create the Supabase account. Supabase emails a confirmation link; opening it signs the
 * user in and brings them back to /signup at step 2. Until then this step shows "check your email"
 * with a resend button. A tenant code is checked against the database as it is typed.
 */
export function StepAccount() {
  const awaitingEmail = useSignupStore((s) => s.awaitingEmail);
  return awaitingEmail ? <CheckEmail email={awaitingEmail} /> : <AccountForm />;
}

function AccountForm() {
  const router = useRouter();
  const account = useSignupStore((s) => s.account);
  const tenant = useSignupStore((s) => s.tenant);
  const navigated = useSignupStore((s) => s.navigated);
  const accountCreated = useSignupStore((s) => s.accountCreated);
  const setTenantCode = useSignupStore((s) => s.setTenantCode);
  const setTenant = useSignupStore((s) => s.setTenant);
  const markStarted = useSignupStore((s) => s.markStarted);

  const [showPassword, setShowPassword] = React.useState(false);
  const [codeOpen, setCodeOpen] = React.useState(account.tenantCode.length > 0);
  const [formError, setFormError] = React.useState<string | null>(null);
  const [checkingCode, setCheckingCode] = React.useState(false);

  const form = useForm<AccountValues>({
    resolver: zodResolver(accountSchema),
    mode: "onTouched",
    defaultValues: { fullName: account.fullName, email: account.email, password: "", tenantCode: account.tenantCode },
  });
  const { register, handleSubmit, control, setError, formState } = form;
  const { errors, isSubmitting } = formState;

  const password = useWatch({ control, name: "password" }) ?? "";
  const tenantCode = useWatch({ control, name: "tenantCode" }) ?? "";
  const cleanCode = tenantCode.trim().toUpperCase();
  const tenantMatch = tenant !== null && tenant.code === cleanCode;

  // The code drives the "Applied" badge and the white-label preview: look it up as it is typed.
  React.useEffect(() => {
    setTenantCode(tenantCode);
    if (!/^[A-Z0-9-]{3,24}$/.test(cleanCode)) {
      if (tenant) setTenant(null);
      return;
    }
    if (tenant?.code === cleanCode) return;
    let cancelled = false;
    const t = window.setTimeout(async () => {
      setCheckingCode(true);
      const res = await lookupTenantCode(cleanCode).catch(() => null);
      if (cancelled) return;
      setCheckingCode(false);
      setTenant(res?.ok && res.tenant ? { code: cleanCode, name: res.tenant.name, branding: res.tenant.branding } : null);
    }, 450);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [tenantCode, cleanCode, tenant, setTenant, setTenantCode]);

  useFocusOnMount("signup-fullName", navigated);

  const onSubmit = async (values: AccountValues) => {
    setFormError(null);
    const res = await signUpAccount({ fullName: values.fullName, email: values.email, password: values.password, tenantCode: values.tenantCode.trim() });
    if (!res.ok) {
      if (res.field === "fullName" || res.field === "email" || res.field === "password" || res.field === "tenantCode") {
        setError(res.field, { message: res.error });
        if (res.field === "tenantCode") setCodeOpen(true);
      } else {
        setFormError(res.error);
      }
      return;
    }
    const draft = { fullName: values.fullName.trim(), email: res.email, tenantCode: values.tenantCode.trim() };
    if (res.needsConfirmation) {
      accountCreated(draft);
      return;
    }
    // Email confirmation is off for this project: the user is signed in already.
    accountCreated(draft);
    useSignupStore.getState().clearAwaiting();
    router.refresh();
  };

  return (
    <StepShell step={1} title="Create your account" description="Use the email you want account notices delivered to. We send a link to confirm it.">
      {formError ? (
        <Alert variant="destructive">
          <TriangleAlertIcon />
          <AlertTitle>{formError}</AlertTitle>
          {formError.includes("Sign in") ? (
            <AlertDescription>
              <Link href="/login" className="font-medium underline underline-offset-3">
                Go to sign in
              </Link>
            </AlertDescription>
          ) : null}
        </Alert>
      ) : null}

      <form id="signup-account-form" noValidate onSubmit={handleSubmit(onSubmit)} onFocus={markStarted} className="grid gap-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="grid gap-1.5">
            <Label htmlFor="signup-fullName">Full name</Label>
            <Input
              id="signup-fullName"
              autoComplete="name"
              placeholder="Alex Rivera"
              aria-invalid={!!errors.fullName}
              aria-describedby={errors.fullName ? "signup-fullName-error" : undefined}
              {...register("fullName")}
            />
            <FieldError id="signup-fullName-error" message={errors.fullName?.message} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="signup-email">Email</Label>
            <Input
              id="signup-email"
              type="email"
              autoComplete="email"
              inputMode="email"
              placeholder="alex@yourfirm.com"
              aria-invalid={!!errors.email}
              aria-describedby={errors.email ? "signup-email-error" : undefined}
              {...register("email")}
            />
            <FieldError id="signup-email-error" message={errors.email?.message} />
          </div>
        </div>

        <div className="grid gap-2">
          <Label htmlFor="signup-password">Password</Label>
          <InputGroup>
            <InputGroupInput
              id="signup-password"
              type={showPassword ? "text" : "password"}
              autoComplete="new-password"
              aria-invalid={!!errors.password}
              aria-describedby={errors.password ? "signup-password-error signup-password-strength" : "signup-password-strength"}
              {...register("password")}
            />
            <InputGroupAddon align="inline-end">
              <InputGroupButton size="icon-xs" aria-label={showPassword ? "Hide password" : "Show password"} aria-pressed={showPassword} onClick={() => setShowPassword((v) => !v)}>
                {showPassword ? <EyeOffIcon /> : <EyeIcon />}
              </InputGroupButton>
            </InputGroupAddon>
          </InputGroup>
          <FieldError id="signup-password-error" message={errors.password?.message} />
          <PasswordStrength id="signup-password-strength" password={password} />
        </div>

        <Collapsible open={codeOpen} onOpenChange={setCodeOpen} className="grid gap-3">
          <CollapsibleTrigger render={<Button type="button" variant="ghost" size="sm" className="w-fit -ml-2.5 text-muted-foreground hover:text-foreground" />}>
            <ChevronDownIcon className={cn("transition-transform", codeOpen && "rotate-180")} />
            Tenant code
            {tenantMatch ? <span className="ml-1 rounded-full bg-brand-soft px-2 py-0.5 text-xs font-medium text-primary">Applied</span> : null}
          </CollapsibleTrigger>
          <CollapsibleContent className="grid gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="signup-tenantCode">Code</Label>
              <Input
                id="signup-tenantCode"
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                className="font-mono uppercase sm:max-w-xs"
                aria-invalid={!!errors.tenantCode}
                aria-describedby={errors.tenantCode ? "signup-tenantCode-error" : "signup-tenantCode-hint"}
                {...register("tenantCode")}
              />
              <FieldError id="signup-tenantCode-error" message={errors.tenantCode?.message} />
              {!errors.tenantCode && !tenantMatch ? (
                <FieldHint id="signup-tenantCode-hint" className="inline-flex items-center gap-1.5">
                  {checkingCode ? <LoaderCircleIcon className="size-3.5 animate-spin" aria-hidden="true" /> : null}
                  {checkingCode
                    ? "Checking the code"
                    : cleanCode.length >= 3
                      ? "No active tenant uses this code. Check it, or leave it empty to sign up directly."
                      : "Only if a tenant who referred you gave you a code. Leave it empty otherwise."}
                </FieldHint>
              ) : null}
            </div>
            {tenantMatch && tenant ? (
              <Alert className="bg-brand-soft/60">
                <HandshakeIcon className="text-primary" />
                <AlertTitle>You are joining through {tenant.name} as a tenant user.</AlertTitle>
                <AlertDescription>
                  {tenant.branding
                    ? `Your terminal wears ${tenant.branding.name}'s brand. Nasscord runs it underneath.`
                    : `You trade from the same terminal as every Nasscord trader, and ${tenant.name} is credited for bringing you.`}
                </AlertDescription>
              </Alert>
            ) : null}
          </CollapsibleContent>
        </Collapsible>

        <p className="text-xs leading-relaxed text-muted-foreground">
          By creating an account you agree to the{" "}
          <Link href="/security#legal" className="underline underline-offset-3 hover:text-foreground">
            Terms of Service
          </Link>{" "}
          and{" "}
          <Link href="/security#legal" className="underline underline-offset-3 hover:text-foreground">
            Privacy Policy
          </Link>
          . Nasscord never holds your funds and never sees your broker password.
        </p>

        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button type="submit" size="lg" disabled={isSubmitting}>
            {isSubmitting ? <LoaderCircleIcon className="animate-spin" /> : null}
            {isSubmitting ? "Creating account" : "Create account"}
          </Button>
        </div>
      </form>
    </StepShell>
  );
}

function CheckEmail({ email }: { email: string }) {
  const clearAwaiting = useSignupStore((s) => s.clearAwaiting);
  const [sending, setSending] = React.useState(false);

  const resend = () => {
    setSending(true);
    React.startTransition(async () => {
      const res = await resendConfirmation({ email });
      setSending(false);
      if (res.ok) toast.success("Link sent again", { description: `Check ${maskEmail(email)}, including spam.` });
      else toast.error("Could not send the link", { description: res.error });
    });
  };

  return (
    <StepShell step={1} title="Check your email" description="Confirm your address to continue setting up.">
      <div className="flex items-start gap-3 rounded-xl bg-brand-soft px-4 py-3">
        <MailCheckIcon className="mt-0.5 size-5 shrink-0 text-primary" aria-hidden="true" />
        <div className="grid gap-1 text-sm">
          <span className="font-semibold">
            We sent a confirmation link to <span className="break-all">{maskEmail(email)}</span>.
          </span>
          <span className="text-muted-foreground">Open it on this device. It signs you in and brings you back here to name your workspace.</span>
        </div>
      </div>
      <ul className="grid gap-1.5 text-sm text-muted-foreground">
        <li>Nothing after a few minutes? Check spam, then send it again.</li>
        <li>Already have an account with this email? Sign in instead; no new email is sent for it.</li>
      </ul>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" onClick={resend} disabled={sending}>
          {sending ? <LoaderCircleIcon className="animate-spin" /> : null}
          Send the link again
        </Button>
        <Button type="button" variant="ghost" onClick={clearAwaiting}>
          Use a different email
        </Button>
        <Button type="button" variant="link" className="px-0" render={<Link href="/login" />}>
          Sign in instead
        </Button>
      </div>
    </StepShell>
  );
}
