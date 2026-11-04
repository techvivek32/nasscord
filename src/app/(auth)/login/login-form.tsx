"use client";

import * as React from "react";
import Link from "next/link";
import { toast } from "sonner";
import { ArrowLeftIcon, EyeIcon, EyeOffIcon, LoaderCircleIcon, MailCheckIcon, TriangleAlertIcon } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group";
import { Label } from "@/components/ui/label";
import { requestPasswordReset, resendConfirmation, signIn, type SignInState } from "@/lib/auth-actions";
import { maskEmail } from "@/lib/format";
import { resetRequestSchema } from "@/lib/signup";

type View = "credentials" | "reset" | "reset-sent";

/**
 * Sign-in card: email and password through the `signIn` server action (useActionState). The action
 * redirects on success and returns an error sentence otherwise. "Forgot password?" sends a real reset
 * link through Supabase; the answer is the same whether or not the address has an account.
 */
export function LoginForm({ next, notice, initialView = "credentials" }: { next?: string; notice: string | null; initialView?: "credentials" | "reset" }) {
  const [state, formAction, pending] = React.useActionState<SignInState, FormData>(signIn, {});
  const [view, setView] = React.useState<View>(initialView);
  const [email, setEmail] = React.useState("");
  const [showPassword, setShowPassword] = React.useState(false);
  const [resetEmail, setResetEmail] = React.useState("");
  const [resetError, setResetError] = React.useState<string | undefined>();
  const [busy, setBusy] = React.useState(false);

  const resend = (address: string) => {
    setBusy(true);
    React.startTransition(async () => {
      const res = await resendConfirmation({ email: address });
      setBusy(false);
      if (res.ok) toast.success("Confirmation link sent", { description: `Check ${maskEmail(address)}, including spam.` });
      else toast.error("Could not send the link", { description: res.error });
    });
  };

  const sendReset = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const parsed = resetRequestSchema.safeParse({ email: resetEmail.trim() });
    if (!parsed.success) {
      setResetError(parsed.error.issues[0]?.message ?? "Enter the email you signed up with.");
      return;
    }
    setResetError(undefined);
    setBusy(true);
    React.startTransition(async () => {
      const res = await requestPasswordReset({ email: parsed.data.email });
      setBusy(false);
      if (!res.ok) {
        setResetError(res.error);
        return;
      }
      setView("reset-sent");
    });
  };

  if (view === "reset-sent") {
    return (
      <Card className="w-full">
        <CardHeader>
          <span className="grid size-9 place-items-center rounded-lg bg-brand-soft text-primary">
            <MailCheckIcon className="size-4" aria-hidden="true" />
          </span>
          <CardTitle className="text-xl tracking-tight">
            <h1 className="tracking-tight">Check your email</h1>
          </CardTitle>
          <CardDescription>
            If <span className="font-medium text-foreground">{maskEmail(resetEmail.trim())}</span> has a Nasscord account, a reset link is on its way. It works once and expires after an hour.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          <p className="text-sm text-muted-foreground">Nothing after a few minutes? Check spam, or send the link again.</p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" onClick={() => setView("reset")}>
              Send again
            </Button>
            <Button type="button" variant="ghost" onClick={() => setView("credentials")}>
              <ArrowLeftIcon />
              Back to sign in
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  if (view === "reset") {
    return (
      <Card className="w-full">
        <CardHeader>
          <CardTitle className="text-xl tracking-tight">
            <h1 className="tracking-tight">Reset your password</h1>
          </CardTitle>
          <CardDescription>We email a single-use link. Your broker connections are not affected.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-5">
          {notice ? (
            <Alert variant="destructive">
              <TriangleAlertIcon />
              <AlertTitle>{notice}</AlertTitle>
            </Alert>
          ) : null}
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
            <Button type="submit" size="lg" className="w-full" disabled={busy}>
              {busy ? <LoaderCircleIcon className="animate-spin" /> : null}
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
      </Card>
    );
  }

  const error = state.error;
  return (
    <Card className="w-full">
      <CardHeader>
        <CardTitle className="text-xl tracking-tight">
          <h1 className="tracking-tight">Sign in</h1>
        </CardTitle>
        <CardDescription>Use the email and password you signed up with.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-5">
        {notice && !error ? (
          <Alert variant="destructive">
            <TriangleAlertIcon />
            <AlertTitle>{notice}</AlertTitle>
          </Alert>
        ) : null}
        {error ? (
          <Alert variant="destructive">
            <TriangleAlertIcon />
            <AlertTitle>{error}</AlertTitle>
            {state.unconfirmedEmail ? (
              <AlertDescription>
                <Button type="button" variant="outline" size="sm" className="mt-1" disabled={busy} onClick={() => resend(state.unconfirmedEmail as string)}>
                  {busy ? <LoaderCircleIcon className="animate-spin" /> : null}
                  Send the confirmation link again
                </Button>
              </AlertDescription>
            ) : null}
          </Alert>
        ) : null}

        <form action={formAction} noValidate className="grid gap-4">
          {next ? <input type="hidden" name="next" value={next} /> : null}
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
              required
              autoFocus
            />
          </div>
          <div className="grid gap-1.5">
            <div className="flex items-center justify-between gap-2">
              <Label htmlFor="login-password">Password</Label>
              <button
                type="button"
                className="text-xs font-medium text-primary underline-offset-4 outline-none hover:underline focus-visible:underline"
                onClick={() => {
                  setResetEmail(email || state.email || "");
                  setResetError(undefined);
                  setView("reset");
                }}
              >
                Forgot password?
              </button>
            </div>
            <InputGroup>
              <InputGroupInput id="login-password" name="password" type={showPassword ? "text" : "password"} autoComplete="current-password" required />
              <InputGroupAddon align="inline-end">
                <InputGroupButton size="icon-xs" aria-label={showPassword ? "Hide password" : "Show password"} aria-pressed={showPassword} onClick={() => setShowPassword((v) => !v)}>
                  {showPassword ? <EyeOffIcon /> : <EyeIcon />}
                </InputGroupButton>
              </InputGroupAddon>
            </InputGroup>
          </div>
          <Button type="submit" size="lg" className="mt-1 w-full" disabled={pending}>
            {pending ? <LoaderCircleIcon className="animate-spin" /> : null}
            {pending ? "Signing in" : "Sign in"}
          </Button>
        </form>
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
    </Card>
  );
}
