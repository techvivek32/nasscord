"use client";

import * as React from "react";
import Link from "next/link";
import { toast } from "sonner";
import { ArrowLeftIcon, EyeIcon, EyeOffIcon, KeyRoundIcon, LoaderCircleIcon, TriangleAlertIcon } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { requestPasswordReset, signIn, signInAs } from "@/lib/auth-actions";
import { maskEmail } from "@/lib/format";
import { CodeInput } from "@/app/(auth)/login/code-input";
import { resetSchema } from "@/components/onboarding/schemas";

type View = "credentials" | "code" | "reset";
type DemoKind = "trader" | "operator" | "partner";

/** Single-role previews. The super admin, who has all of them, gets its own button above these. */
const DEMO: ReadonlyArray<{ kind: DemoKind; label: string; hint: string }> = [
  { kind: "trader", label: "Trader", hint: "Customer's terminal" },
  { kind: "operator", label: "Operator", hint: "Staff console" },
  { kind: "partner", label: "Partner", hint: "Acme Capital portal" },
];

/**
 * Sign-in card. Credentials are validated on the client, held in component state through the
 * two-factor step, then posted to the `signIn` server action as FormData. The action redirects
 * on success and sends `?error=invalid` back here on failure; the page remounts this component.
 */
export function LoginForm({ next, invalid }: { next?: string; invalid: boolean }) {
  const [view, setView] = React.useState<View>("credentials");
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [showPassword, setShowPassword] = React.useState(false);
  const [errors, setErrors] = React.useState<{ email?: string; password?: string }>({});
  const [code, setCode] = React.useState("");
  const [codeError, setCodeError] = React.useState<string | undefined>();
  const [pending, setPending] = React.useState(false);
  const [resetEmail, setResetEmail] = React.useState("");
  const [resetError, setResetError] = React.useState<string | undefined>();

  const continueToCode = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const nextErrors: typeof errors = {};
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) nextErrors.email = "Enter a valid email address.";
    if (password.length < 6) nextErrors.password = "Passwords are at least 6 characters.";
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length) return;
    setCode("");
    setCodeError(undefined);
    setView("code");
  };

  const verify = (value: string) => {
    if (!/^\d{6}$/.test(value)) {
      setCodeError("Enter the six digits from your authenticator app.");
      return;
    }
    setCodeError(undefined);
    setPending(true);
    const fd = new FormData();
    fd.set("email", email.trim());
    fd.set("password", password);
    if (next) fd.set("next", next);
    React.startTransition(async () => {
      try {
        await signIn(fd);
      } catch (err) {
        // Next.js implements redirect() by throwing; anything else is a real failure.
        if (err instanceof Error && "digest" in err && String((err as { digest?: string }).digest).startsWith("NEXT_REDIRECT")) throw err;
        setPending(false);
        toast.error("Sign-in failed", { description: "Try again in a moment." });
      }
    });
  };

  const sendReset = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const parsed = resetSchema.safeParse({ email: resetEmail.trim() });
    if (!parsed.success) {
      setResetError(parsed.error.issues[0]?.message ?? "Enter the email you signed up with.");
      return;
    }
    setResetError(undefined);
    setPending(true);
    React.startTransition(async () => {
      await requestPasswordReset({ email: resetEmail });
      setPending(false);
      toast("If that address exists, a reset link is on its way", { description: `Sent to ${maskEmail(resetEmail.trim())}. Check spam if it does not arrive in a few minutes.` });
      setView("credentials");
    });
  };

  return (
    <Card className="w-full">
      {view === "credentials" ? (
        <>
          <CardHeader>
            <CardTitle className="text-xl tracking-tight">
              <h1 className="tracking-tight">Sign in</h1>
            </CardTitle>
            <CardDescription>Use your work email. Two-factor is required on live trading accounts.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-5">
            {invalid ? (
              <Alert variant="destructive">
                <TriangleAlertIcon />
                <AlertTitle>That email and password did not match.</AlertTitle>
                <AlertDescription>Check both and try again, or reset your password below.</AlertDescription>
              </Alert>
            ) : null}

            <form noValidate onSubmit={continueToCode} className="grid gap-4">
              <div className="grid gap-1.5">
                <Label htmlFor="login-email">Email</Label>
                <Input
                  id="login-email"
                  name="email"
                  type="email"
                  autoComplete="email"
                  inputMode="email"
                  placeholder="you@yourfirm.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  aria-invalid={!!errors.email}
                  aria-describedby={errors.email ? "login-email-error" : undefined}
                  autoFocus
                />
                {errors.email ? (
                  <p id="login-email-error" role="alert" className="text-xs text-loss-foreground">
                    {errors.email}
                  </p>
                ) : null}
              </div>
              <div className="grid gap-1.5">
                <div className="flex items-center justify-between gap-2">
                  <Label htmlFor="login-password">Password</Label>
                  <button
                    type="button"
                    className="text-xs font-medium text-primary underline-offset-4 outline-none hover:underline focus-visible:underline"
                    onClick={() => {
                      setResetEmail(email);
                      setResetError(undefined);
                      setView("reset");
                    }}
                  >
                    Forgot password?
                  </button>
                </div>
                <InputGroup>
                  <InputGroupInput
                    id="login-password"
                    name="password"
                    type={showPassword ? "text" : "password"}
                    autoComplete="current-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    aria-invalid={!!errors.password}
                    aria-describedby={errors.password ? "login-password-error" : undefined}
                  />
                  <InputGroupAddon align="inline-end">
                    <InputGroupButton size="icon-xs" aria-label={showPassword ? "Hide password" : "Show password"} aria-pressed={showPassword} onClick={() => setShowPassword((v) => !v)}>
                      {showPassword ? <EyeOffIcon /> : <EyeIcon />}
                    </InputGroupButton>
                  </InputGroupAddon>
                </InputGroup>
                {errors.password ? (
                  <p id="login-password-error" role="alert" className="text-xs text-loss-foreground">
                    {errors.password}
                  </p>
                ) : null}
              </div>
              <Button type="submit" size="lg" className="mt-1 w-full">
                Continue
              </Button>
            </form>

            <div className="flex items-center gap-3" role="separator" aria-label="or">
              <Separator className="flex-1" />
              <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">or</span>
              <Separator className="flex-1" />
            </div>

            <div className="grid gap-2">
              <div className="grid gap-2 sm:grid-cols-2">
                <form action={() => signInAs("trader", next)}>
                  <Button type="submit" variant="outline" size="lg" className="w-full">
                    <GoogleMark />
                    Continue with Google
                  </Button>
                </form>
                <form action={() => signInAs("trader", next)}>
                  <Button type="submit" variant="outline" size="lg" className="w-full">
                    <AppleMark />
                    Continue with Apple
                  </Button>
                </form>
              </div>
              <p className="text-xs text-muted-foreground">Demo: single sign-on opens the demo trader&apos;s terminal without contacting Google or Apple.</p>
            </div>

            <div className="grid gap-2">
              <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Demo identities</p>
              <form action={() => signInAs("superadmin", next)} className="grid">
                <Button type="submit" variant="secondary" className="h-auto items-center justify-between gap-3 px-2.5 py-2 text-left">
                  <span className="flex min-w-0 flex-col">
                    <span className="text-sm font-medium">Super admin</span>
                    <span className="text-[11px] font-normal whitespace-normal text-muted-foreground">Vivek Desai, platform owner. Console, terminal and partner portal.</span>
                  </span>
                  <span className="shrink-0 rounded-4xl bg-brand-soft px-2 py-0.5 text-[11px] font-medium text-primary">Full access</span>
                </Button>
              </form>
              <p className="text-xs text-muted-foreground">Or see what one role sees:</p>
              <div className="grid grid-cols-3 gap-2">
                {DEMO.map((d) => (
                  <form key={d.kind} action={() => signInAs(d.kind, next)} className="grid">
                    <Button type="submit" variant="secondary" className="h-auto flex-col items-start gap-0 px-2.5 py-2 text-left">
                      <span className="text-sm font-medium">{d.label}</span>
                      <span className="text-[11px] font-normal text-muted-foreground">{d.hint}</span>
                    </Button>
                  </form>
                ))}
              </div>
            </div>
          </CardContent>
          <CardFooter className="justify-between text-xs text-muted-foreground">
            <span>
              New here?{" "}
              <Link href="/signup" className="font-medium text-primary underline-offset-4 hover:underline">
                Create your workspace
              </Link>
            </span>
            <Link href="/security" className="underline-offset-4 hover:underline">
              Security
            </Link>
          </CardFooter>
        </>
      ) : null}

      {view === "code" ? (
        <>
          <CardHeader>
            <span className="grid size-9 place-items-center rounded-lg bg-brand-soft text-primary">
              <KeyRoundIcon className="size-4" aria-hidden="true" />
            </span>
            <CardTitle className="text-xl tracking-tight">
              <h1 className="tracking-tight">Two-factor code</h1>
            </CardTitle>
            <CardDescription>
              Enter the six-digit code from your authenticator app for <span className="font-medium text-foreground">{maskEmail(email.trim())}</span>.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-5">
            <form
              noValidate
              onSubmit={(e) => {
                e.preventDefault();
                verify(code);
              }}
              className="grid gap-4"
            >
              <div className="grid gap-2">
                <span id="login-code-label" className="text-sm font-medium">
                  Verification code
                </span>
                <CodeInput value={code} onChange={setCode} onComplete={verify} disabled={pending} invalid={!!codeError} describedBy={codeError ? "login-code-error" : "login-code-hint"} autoFocus />
                {codeError ? (
                  <p id="login-code-error" role="alert" className="text-xs text-loss-foreground">
                    {codeError}
                  </p>
                ) : (
                  <p id="login-code-hint" className="text-xs text-muted-foreground">
                    Demo: any six digits are accepted.
                  </p>
                )}
              </div>
              <Button type="submit" size="lg" className="w-full" disabled={pending || code.length < 6}>
                {pending ? <LoaderCircleIcon className="animate-spin" /> : null}
                {pending ? "Signing in" : "Verify and sign in"}
              </Button>
            </form>
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
              <button
                type="button"
                className="inline-flex items-center gap-1 text-muted-foreground underline-offset-4 outline-none hover:underline focus-visible:underline"
                onClick={() => setView("credentials")}
                disabled={pending}
              >
                <ArrowLeftIcon className="size-3.5" aria-hidden="true" />
                Use a different account
              </button>
              <button
                type="button"
                className="font-medium text-primary underline-offset-4 outline-none hover:underline focus-visible:underline"
                disabled={pending}
                onClick={() => toast("Code sent again", { description: "Check your authenticator app or the SMS fallback on file." })}
              >
                Resend code
              </button>
            </div>
          </CardContent>
        </>
      ) : null}

      {view === "reset" ? (
        <>
          <CardHeader>
            <CardTitle className="text-xl tracking-tight">
              <h1 className="tracking-tight">Reset your password</h1>
            </CardTitle>
            <CardDescription>We email a single-use link that expires in 30 minutes. Broker connections are not affected.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-5">
            <form noValidate onSubmit={sendReset} className="grid gap-4">
              <div className="grid gap-1.5">
                <Label htmlFor="login-reset-email">Email</Label>
                <Input
                  id="login-reset-email"
                  type="email"
                  autoComplete="email"
                  inputMode="email"
                  placeholder="you@yourfirm.com"
                  value={resetEmail}
                  onChange={(e) => setResetEmail(e.target.value)}
                  aria-invalid={!!resetError}
                  aria-describedby={resetError ? "login-reset-email-error" : undefined}
                  autoFocus
                />
                {resetError ? (
                  <p id="login-reset-email-error" role="alert" className="text-xs text-loss-foreground">
                    {resetError}
                  </p>
                ) : null}
              </div>
              <Button type="submit" size="lg" className="w-full" disabled={pending}>
                {pending ? <LoaderCircleIcon className="animate-spin" /> : null}
                Send reset link
              </Button>
            </form>
            <button
              type="button"
              className="inline-flex w-fit items-center gap-1 text-xs text-muted-foreground underline-offset-4 outline-none hover:underline focus-visible:underline"
              onClick={() => setView("credentials")}
            >
              <ArrowLeftIcon className="size-3.5" aria-hidden="true" />
              Back to sign in
            </button>
          </CardContent>
        </>
      ) : null}
    </Card>
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
