import type { Role } from "@/lib/types";

/* ------------------------------------------------------------------
   Who may open which area. One definition, used by proxy.ts (optimistic
   gate), the area layouts (enforced) and the area switcher in the shell.
   Pure data: safe to import from the proxy, server and client code.

   The four roles:
     superadmin  the platform owner. Console (including White-label),
                 the tenant portal (to support a tenant) and their own terminal.
     tenant      a distributor. Earns commission on the traders they bring;
                 gets white-label when the super admin grants it. Tenant portal only.
     trader      an organic user who signed up directly. Terminal only.
     tenant_user a trader who belongs to a tenant. Terminal only, in the
                 tenant's brand when white-label is on.
   ------------------------------------------------------------------ */

export type AreaId = "terminal" | "console" | "tenant";

export const ROLES: Role[] = ["superadmin", "tenant", "trader", "tenant_user"];

export const ROLE_LABEL: Record<Role, string> = {
  superadmin: "Super admin",
  tenant: "Tenant",
  trader: "Trader",
  tenant_user: "Tenant user",
};

/** One plain sentence per role, for the login page and the console's Users page. */
export const ROLE_DESCRIPTION: Record<Role, string> = {
  superadmin: "Owns the platform. Runs the console, grants white-label and trades from their own desk.",
  tenant: "A distributor. Earns commission on the traders they bring, with white-label when it is granted.",
  trader: "Signed up directly. Trades from the terminal.",
  tenant_user: "Belongs to a tenant. Trades from the terminal in that tenant's brand.",
};

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as string[]).includes(value);
}

/** The console, White-label page included, is the super admin's alone. */
export const CONSOLE_ROLES: Role[] = ["superadmin"];
/** Tenants, and the super admin when supporting one. */
export const TENANT_PORTAL_ROLES: Role[] = ["tenant", "superadmin"];
/** Everyone who trades. A tenant's own login does not. */
export const TERMINAL_ROLES: Role[] = ["superadmin", "trader", "tenant_user"];

export function isStaff(role: Role) {
  return CONSOLE_ROLES.includes(role);
}

/** Areas a role works in, in the order the switcher lists them. One entry means no switcher. */
export function areasForRole(role: Role): AreaId[] {
  switch (role) {
    case "superadmin":
      return ["console", "terminal", "tenant"];
    case "tenant":
      return ["tenant"];
    default:
      return ["terminal"];
  }
}

export function homeForRole(role: Role) {
  return role === "superadmin" ? "/admin" : role === "tenant" ? "/tenant" : "/app";
}
