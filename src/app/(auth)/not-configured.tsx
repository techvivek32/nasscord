import Link from "next/link";
import { TriangleAlertIcon } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

/** Shown by the sign-in, signup and reset pages when the Supabase env vars are missing. */
export function NotConfigured({ title }: { title: string }) {
  return (
    <Card className="w-full">
      <CardHeader>
        <CardTitle className="text-xl tracking-tight">
          <h1 className="tracking-tight">{title}</h1>
        </CardTitle>
        <CardDescription>Accounts are not available on this deployment yet.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <Alert variant="destructive">
          <TriangleAlertIcon />
          <AlertTitle>Supabase is not configured.</AlertTitle>
          <AlertDescription>
            Set <span className="font-mono">NEXT_PUBLIC_SUPABASE_URL</span>, <span className="font-mono">NEXT_PUBLIC_SUPABASE_ANON_KEY</span> and{" "}
            <span className="font-mono">SUPABASE_SERVICE_ROLE_KEY</span>, then restart the app. docs/SETUP.md has the steps.
          </AlertDescription>
        </Alert>
        <Button variant="outline" className="w-fit" render={<Link href="/" />}>
          Back to the site
        </Button>
      </CardContent>
    </Card>
  );
}
