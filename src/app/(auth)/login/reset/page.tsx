import type { Metadata } from "next";
import Link from "next/link";
import { AuthHeader } from "@/app/(auth)/auth-header";
import { NotConfigured } from "@/app/(auth)/not-configured";
import { ResetPasswordForm } from "@/app/(auth)/login/reset/reset-form";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getAuthUser } from "@/lib/auth";
import { maskEmail } from "@/lib/format";
import { isSupabaseConfigured } from "@/lib/supabase/env";

export const metadata: Metadata = {
  title: "Set a new password",
  description: "Choose a new password for your Nasscord account.",
};

/**
 * Where the password reset email lands (through /auth/confirm, which signed the user in).
 * Without that session the link was used or expired, and the page says so.
 */
export default async function ResetPasswordPage() {
  const configured = isSupabaseConfigured();
  const user = configured ? await getAuthUser() : null;

  return (
    <div className="flex min-h-full flex-1 flex-col">
      <AuthHeader prompt="Remembered it?" linkLabel="Sign in" href="/login" />
      <main className="flex flex-1 items-start px-4 py-8 sm:px-6 lg:px-10 lg:py-12">
        <div className="mx-auto w-full max-w-md">
          {!configured ? (
            <NotConfigured title="Set a new password" />
          ) : user ? (
            <ResetPasswordForm email={maskEmail(user.email)} />
          ) : (
            <Card className="w-full">
              <CardHeader>
                <CardTitle className="text-xl tracking-tight">
                  <h1 className="tracking-tight">This reset link has expired</h1>
                </CardTitle>
                <CardDescription>Reset links work once and expire after an hour. Request a new one and open it on this device.</CardDescription>
              </CardHeader>
              <CardContent>
                <Button render={<Link href="/login?view=reset" />}>Request a new link</Button>
              </CardContent>
            </Card>
          )}
        </div>
      </main>
    </div>
  );
}
