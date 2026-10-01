import type { TenantBranding } from "@/lib/types";

/**
 * White-label accent. Overrides the brand tokens for everything rendered inside, so buttons,
 * focus rings, links and the sidebar active state pick up the tenant color without any component
 * knowing about tenants. Pure CSS (light + .dark rules), so it renders correctly on the server.
 * `display: contents` keeps the wrapper out of the layout; custom properties still inherit.
 */
export function TenantTheme({ branding, children }: { branding: TenantBranding; children: React.ReactNode }) {
  const light = vars(branding.accent, "#ffffff");
  const dark = vars(branding.accentDark, "#0b0e17");
  const css = `[data-tenant-theme]{${light}}.dark [data-tenant-theme]{${dark}}`;

  return (
    <div data-tenant-theme="" style={{ display: "contents" }}>
      <style dangerouslySetInnerHTML={{ __html: css }} />
      {children}
    </div>
  );
}

function vars(accent: string, fg: string) {
  return [
    `--primary:${accent}`,
    `--primary-foreground:${fg}`,
    `--ring:${accent}`,
    `--sidebar-primary:${accent}`,
    `--sidebar-primary-foreground:${fg}`,
    `--sidebar-ring:${accent}`,
    `--brand-soft:color-mix(in oklab, ${accent} 14%, var(--card))`,
  ].join(";");
}
