/**
 * Partner settings tabs. Kept outside the "use client" settings module so the server page can
 * validate ?tab= before rendering (a server component cannot call a function exported from a client module).
 */
export type SettingsTab = "contacts" | "notifications" | "api" | "legal";

export const SETTINGS_TABS: SettingsTab[] = ["contacts", "notifications", "api", "legal"];

export function isSettingsTab(v: string | undefined): v is SettingsTab {
  return !!v && (SETTINGS_TABS as string[]).includes(v);
}
