"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { EyeIcon, EyeOffIcon, LoaderCircleIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group";
import { Label } from "@/components/ui/label";
import { PasswordStrength } from "@/components/onboarding/password-strength";
import { updatePassword } from "@/lib/auth-actions";
import { newPasswordSchema } from "@/lib/signup";

/** New password + confirmation, saved with the `updatePassword` server action. */
export function ResetPasswordForm({ email }: { email: string }) {
  const router = useRouter();
  const [password, setPassword] = React.useState("");
  const [confirm, setConfirm] = React.useState("");
  const [show, setShow] = React.useState(false);
  const [error, setError] = React.useState<{ password?: string; confirm?: string }>({});
  const [pending, setPending] = React.useState(false);

  const submit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const parsed = newPasswordSchema.safeParse(password);
    if (!parsed.success) {
      setError({ password: parsed.error.issues[0]?.message });
      return;
    }
    if (confirm !== password) {
      setError({ confirm: "The two passwords do not match." });
      return;
    }
    setError({});
    setPending(true);
    React.startTransition(async () => {
      const res = await updatePassword({ password });
      if (!res.ok) {
        setPending(false);
        setError({ password: res.error });
        return;
      }
      toast.success("Password changed", { description: "Use it the next time you sign in." });
      router.replace(res.next);
    });
  };

  return (
    <Card className="w-full">
      <CardHeader>
        <CardTitle className="text-xl tracking-tight">
          <h1 className="tracking-tight">Set a new password</h1>
        </CardTitle>
        <CardDescription>
          For <span className="font-medium text-foreground">{email}</span>. Other devices stay signed in until they sign out.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form noValidate onSubmit={submit} className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="reset-password">New password</Label>
            <InputGroup>
              <InputGroupInput
                id="reset-password"
                type={show ? "text" : "password"}
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                aria-invalid={!!error.password}
                aria-describedby={error.password ? "reset-password-error reset-password-strength" : "reset-password-strength"}
                autoFocus
              />
              <InputGroupAddon align="inline-end">
                <InputGroupButton size="icon-xs" aria-label={show ? "Hide password" : "Show password"} aria-pressed={show} onClick={() => setShow((v) => !v)}>
                  {show ? <EyeOffIcon /> : <EyeIcon />}
                </InputGroupButton>
              </InputGroupAddon>
            </InputGroup>
            {error.password ? (
              <p id="reset-password-error" role="alert" className="text-xs text-loss-foreground">
                {error.password}
              </p>
            ) : null}
            <PasswordStrength id="reset-password-strength" password={password} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="reset-confirm">Type it again</Label>
            <InputGroup>
              <InputGroupInput
                id="reset-confirm"
                type={show ? "text" : "password"}
                autoComplete="new-password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                aria-invalid={!!error.confirm}
                aria-describedby={error.confirm ? "reset-confirm-error" : undefined}
              />
            </InputGroup>
            {error.confirm ? (
              <p id="reset-confirm-error" role="alert" className="text-xs text-loss-foreground">
                {error.confirm}
              </p>
            ) : null}
          </div>
          <Button type="submit" size="lg" className="w-full" disabled={pending}>
            {pending ? <LoaderCircleIcon className="animate-spin" /> : null}
            Save the new password
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
