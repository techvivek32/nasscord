"use client";

import * as React from "react";
import Link from "next/link";
import { useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { ChevronDownIcon, EyeIcon, EyeOffIcon, HandshakeIcon } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { PARTNER_CODE, SSO_IDENTITIES, type SsoProvider } from "@/components/onboarding/data";
import { PasswordStrength } from "@/components/onboarding/password-strength";
import { accountSchema, type AccountValues } from "@/components/onboarding/schemas";
import { FieldError, FieldHint, StepShell, useFocusOnMount } from "@/components/onboarding/step-shell";
import { isPartnerCode, useSignupStore } from "@/components/onboarding/store";
import { cn } from "@/lib/utils";

const SSO_LABEL: Record<SsoProvider, string> = { google: "Google", apple: "Apple" };

/** Step 1: who you are. SSO fills a demo identity; the form path validates with zod. */
export function StepAccount({ partnerName }: { partnerName: string }) {
  const account = useSignupStore((s) => s.account);
  const navigated = useSignupStore((s) => s.navigated);
  const submitAccount = useSignupStore((s) => s.submitAccount);
  const setPartnerCode = useSignupStore((s) => s.setPartnerCode);
  const markStarted = useSignupStore((s) => s.markStarted);

  const [showPassword, setShowPassword] = React.useState(false);
  const [codeOpen, setCodeOpen] = React.useState(account.partnerCode.length > 0);

  const form = useForm<AccountValues>({
    resolver: zodResolver(accountSchema),
    mode: "onTouched",
    defaultValues: {
      fullName: account.fullName,
      email: account.email,
      password: "",
      partnerCode: account.partnerCode,
    },
  });
  const { register, handleSubmit, control, getValues, formState } = form;
  const { errors, isSubmitting } = formState;

  const password = useWatch({ control, name: "password" }) ?? "";
  const partnerCode = useWatch({ control, name: "partnerCode" }) ?? "";
  const partnerMatch = isPartnerCode(partnerCode);

  // The partner code drives the live white-label preview around this card, so it goes to the store as typed.
  React.useEffect(() => {
    setPartnerCode(partnerCode);
  }, [partnerCode, setPartnerCode]);

  useFocusOnMount("signup-fullName", navigated);

  const onSubmit = (values: AccountValues) => {
    submitAccount({ fullName: values.fullName, email: values.email, password: values.password, partnerCode: values.partnerCode.trim() });
  };

  const onSso = (provider: SsoProvider) => {
    const identity = SSO_IDENTITIES[provider];
    markStarted();
    toast.success(`Signed in with ${SSO_LABEL[provider]}`, { description: `${identity.fullName} · ${identity.email}. Demo identity, nothing was sent to ${SSO_LABEL[provider]}.` });
    submitAccount({ fullName: identity.fullName, email: identity.email, password: "", partnerCode: getValues("partnerCode").trim() }, provider);
  };

  return (
    <StepShell step={1} title="Create your account" description="Use the email you want alerts and broker notices delivered to.">
      <div className="grid gap-2 sm:grid-cols-2">
        <Button type="button" variant="outline" size="lg" onClick={() => onSso("google")}>
          <GoogleMark />
          Continue with Google
        </Button>
        <Button type="button" variant="outline" size="lg" onClick={() => onSso("apple")}>
          <AppleMark />
          Continue with Apple
        </Button>
        <FieldHint className="sm:col-span-2">Demo: single sign-on fills a sample identity and moves you to the next step.</FieldHint>
      </div>

      <div className="flex items-center gap-3" role="separator" aria-label="or continue with email">
        <Separator className="flex-1" />
        <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">or</span>
        <Separator className="flex-1" />
      </div>

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
            <Label htmlFor="signup-email">Work email</Label>
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
              <InputGroupButton
                size="icon-xs"
                aria-label={showPassword ? "Hide password" : "Show password"}
                aria-pressed={showPassword}
                onClick={() => setShowPassword((v) => !v)}
              >
                {showPassword ? <EyeOffIcon /> : <EyeIcon />}
              </InputGroupButton>
            </InputGroupAddon>
          </InputGroup>
          <FieldError id="signup-password-error" message={errors.password?.message} />
          <PasswordStrength id="signup-password-strength" password={password} />
        </div>

        <Collapsible open={codeOpen} onOpenChange={setCodeOpen} className="grid gap-3">
          <CollapsibleTrigger
            render={<Button type="button" variant="ghost" size="sm" className="w-fit -ml-2.5 text-muted-foreground hover:text-foreground" />}
          >
            <ChevronDownIcon className={cn("transition-transform", codeOpen && "rotate-180")} />
            Invite or partner code
            {partnerMatch ? <span className="ml-1 rounded-full bg-brand-soft px-2 py-0.5 text-xs font-medium text-primary">Applied</span> : null}
          </CollapsibleTrigger>
          <CollapsibleContent className="grid gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="signup-partnerCode">Code</Label>
              <Input
                id="signup-partnerCode"
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                placeholder={PARTNER_CODE}
                className="font-mono uppercase sm:max-w-xs"
                aria-invalid={!!errors.partnerCode}
                aria-describedby={errors.partnerCode ? "signup-partnerCode-error" : "signup-partnerCode-hint"}
                {...register("partnerCode")}
              />
              <FieldError id="signup-partnerCode-error" message={errors.partnerCode?.message} />
              {!partnerMatch ? (
                <FieldHint id="signup-partnerCode-hint">
                  Codes come from a teammate&apos;s invite or a partner firm. Try <span className="font-mono">{PARTNER_CODE}</span> to see the white-label flow.
                </FieldHint>
              ) : null}
            </div>
            {partnerMatch ? (
              <Alert className="bg-brand-soft/60">
                <HandshakeIcon className="text-primary" />
                <AlertTitle>You are joining through {partnerName} (white-label partner).</AlertTitle>
                <AlertDescription>Their branding and pricing apply. Your workspace runs on Nasscord under their name.</AlertDescription>
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
            Create account
          </Button>
        </div>
      </form>
    </StepShell>
  );
}

function GoogleMark() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="size-4">
      <path fill="currentColor" d="M21.6 12.2c0-.7-.1-1.3-.2-1.9H12v3.7h5.4a4.6 4.6 0 0 1-2 3v2.5h3.2c1.9-1.7 3-4.3 3-7.3Z" opacity=".9" />
      <path fill="currentColor" d="M12 22c2.7 0 5-.9 6.6-2.4l-3.2-2.5c-.9.6-2 1-3.4 1a6 6 0 0 1-5.6-4.1H3.1v2.6A10 10 0 0 0 12 22Z" opacity=".7" />
      <path fill="currentColor" d="M6.4 13.9a6 6 0 0 1 0-3.8V7.5H3.1a10 10 0 0 0 0 9l3.3-2.6Z" opacity=".5" />
      <path fill="currentColor" d="M12 6a5.4 5.4 0 0 1 3.8 1.5l2.9-2.9A9.7 9.7 0 0 0 12 2a10 10 0 0 0-8.9 5.5l3.3 2.6A6 6 0 0 1 12 6Z" opacity=".8" />
    </svg>
  );
}

function AppleMark() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="size-4">
      <path
        fill="currentColor"
        d="M16.4 12.6c0-2.2 1.8-3.3 1.9-3.3a4.2 4.2 0 0 0-3.2-1.7c-1.4-.1-2.7.8-3.4.8-.7 0-1.8-.8-3-.8A4.5 4.5 0 0 0 5 9.9c-1.6 2.8-.4 7 1.2 9.2.8 1.1 1.7 2.3 2.9 2.3s1.6-.7 3-.7 1.8.7 3 .7 2-1.1 2.8-2.2a9.7 9.7 0 0 0 1.3-2.6 4 4 0 0 1-2.8-4ZM14.3 6a3.9 3.9 0 0 0 .9-2.9 4 4 0 0 0-2.6 1.4 3.7 3.7 0 0 0-.9 2.8A3.3 3.3 0 0 0 14.3 6Z"
      />
    </svg>
  );
}
