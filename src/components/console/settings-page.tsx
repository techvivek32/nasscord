import { StatusDot } from "@/components/status-dot";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { KV } from "./primitives";

/** What the Settings page shows. Values are read from the server's environment; secrets arrive only as set or not set. */
export interface PlatformConfig {
  platformName: string;
  appDomain: string;
  siteUrl: string | null;
  accent: string;
  accentDark: string;
  supabaseHost: string | null;
  serviceRoleKeySet: boolean;
  brokerServiceUrl: string | null;
  brokerServiceSecretSet: boolean;
  superadminEmails: string[];
  account: { name: string; email: string; role: string };
}

const isSet = (on: boolean) => (on ? <StatusDot tone="good" label="Set" /> : <StatusDot tone="warn" label="Not set" />);
const orNotSet = (v: string | null) => (v ? <span className="font-mono text-xs break-all">{v}</span> : <StatusDot tone="warn" label="Not set" />);

export function SettingsPage({ config }: { config: PlatformConfig }) {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>Platform</CardTitle>
          <CardDescription>Name, domains and the default brand traders see without white-label.</CardDescription>
        </CardHeader>
        <CardContent>
          <KV
            items={[
              { label: "Name", value: config.platformName },
              { label: "App domain", value: <span className="font-mono text-xs">{config.appDomain}</span> },
              { label: "Site URL", value: orNotSet(config.siteUrl) },
              {
                label: "Accent",
                value: (
                  <span className="font-mono text-xs uppercase">
                    {config.accent} light · {config.accentDark} dark
                  </span>
                ),
              },
            ]}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Services</CardTitle>
          <CardDescription>Where the app finds its database and the broker service. Keys are never shown.</CardDescription>
        </CardHeader>
        <CardContent>
          <KV
            items={[
              { label: "Supabase project", value: orNotSet(config.supabaseHost) },
              { label: "Service role key", value: isSet(config.serviceRoleKeySet) },
              { label: "Broker service URL", value: orNotSet(config.brokerServiceUrl) },
              { label: "Broker service secret", value: isSet(config.brokerServiceSecretSet) },
            ]}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Super admin</CardTitle>
          <CardDescription>A confirmed signup with one of these emails becomes super admin (NASSCORD_SUPERADMIN_EMAILS).</CardDescription>
        </CardHeader>
        <CardContent>
          {config.superadminEmails.length ? (
            <ul className="grid gap-1.5">
              {config.superadminEmails.map((e) => (
                <li key={e} className="font-mono text-xs">
                  {e}
                </li>
              ))}
            </ul>
          ) : (
            <StatusDot tone="warn" label="No email listed" />
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Your account</CardTitle>
          <CardDescription>The login changes in this console are recorded under.</CardDescription>
        </CardHeader>
        <CardContent>
          <KV
            items={[
              { label: "Name", value: config.account.name },
              { label: "Email", value: <span className="font-mono text-xs">{config.account.email}</span> },
              { label: "Role", value: config.account.role },
            ]}
          />
        </CardContent>
      </Card>
    </div>
  );
}
