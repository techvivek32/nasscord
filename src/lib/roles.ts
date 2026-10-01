import type { Role } from "@/lib/types";

/* ------------------------------------------------------------------
   Who may open which area. One definition, used by proxy.ts (optimistic
   gate), the area layouts (enforced) and the area switcher in the shell.
   Pure data: safe to import from the proxy, server and client code.
   ------------------------------------------------------------------ */

export type AreaId = "terminal" | "console" | "partner";

export const ROLE_LABEL: Record<Role, string> = {
  owner: "Owner",
  trader: "Trader",
  viewer: "Viewer",
  operator: "Operator",
  superadmin: "Super admin",
  partner: "Partner",
};

/** Platform staff. The super admin is the platform owner: everything an operator can do, plus their own terminal. */
export const CONSOLE_ROLES: Role[] = ["operator", "superadmin"];
/** Partners, and staff who enter the portal to support a partner. */
export const PARTNER_PORTAL_ROLES: Role[] = ["partner", "operator", "superadmin"];

export function isStaff(role: Role) {
  return CONSOLE_ROLES.includes(role);
}

/** Areas a role works in, in the order the switcher lists them. One entry means no switcher. */
export function areasForRole(role: Role): AreaId[] {
  switch (role) {
    case "superadmin":
      return ["console", "terminal", "partner"];
    case "operator":
      return ["console", "partner"];
    case "partner":
      return ["partner"];
    default:
      return ["terminal"];
  }
}

export function homeForRole(role: Role) {
  return role === "operator" || role === "superadmin" ? "/admin" : role === "partner" ? "/partner" : "/app";
}
