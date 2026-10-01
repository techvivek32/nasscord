const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
const usd0 = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const num0 = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

export function fmtMoney(v: number, opts: { digits?: 0 | 2; sign?: boolean; compact?: boolean } = {}) {
  const { digits = 2, sign = false, compact = false } = opts;
  const abs = Math.abs(v);
  let body: string;
  if (compact && abs >= 1000) body = "$" + fmtCompact(abs);
  else body = digits === 0 ? usd0.format(abs) : usd.format(abs);
  const prefix = v < 0 ? "-" : sign && v > 0 ? "+" : "";
  return prefix + body;
}

export function fmtCompact(v: number, digits = 1) {
  const abs = Math.abs(v);
  const sign = v < 0 ? "-" : "";
  if (abs >= 1e9) return sign + (abs / 1e9).toFixed(abs >= 1e10 ? 0 : digits) + "B";
  if (abs >= 1e6) return sign + (abs / 1e6).toFixed(abs >= 1e7 ? 0 : digits) + "M";
  if (abs >= 1e3) return sign + (abs / 1e3).toFixed(abs >= 1e4 ? 0 : digits) + "K";
  return sign + (Number.isInteger(abs) ? String(abs) : abs.toFixed(digits));
}

export function fmtPct(v: number, digits = 2, sign = true) {
  return (sign && v > 0 ? "+" : "") + v.toFixed(digits) + "%";
}

export function fmtNum(v: number, digits = 0) {
  return digits === 0 ? num0.format(v) : v.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function fmtPrice(v: number) {
  return v >= 1000 ? v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : v.toFixed(2);
}

export function fmtTimeET(iso: string, opts: Intl.DateTimeFormatOptions = {}) {
  return new Date(iso).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", timeZone: "America/New_York", ...opts }) + " ET";
}

export function fmtDate(iso: string, opts: Intl.DateTimeFormatOptions = {}) {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", ...opts });
}

export function fmtDateTime(iso: string) {
  return new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "America/New_York" }) + " ET";
}

/** Eastern trading-day key, so one session never splits across two dates for a viewer elsewhere. */
export function etDayKey(iso: string) {
  return new Date(iso).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

export function timeAgo(iso: string, now: Date = new Date()) {
  const diff = Math.max(0, now.getTime() - new Date(iso).getTime());
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} d ago`;
  return fmtDate(iso, { year: undefined });
}

export function maskEmail(email: string) {
  const [user, domain] = email.split("@");
  if (!domain) return email;
  return `${user.slice(0, 1)}•••@${domain}`;
}

export function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? "")
    .join("");
}

export function slugify(s: string) {
  return s
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
}

export function clsxNum(v: number) {
  return v > 0 ? "text-gain-foreground" : v < 0 ? "text-loss-foreground" : "text-muted-foreground";
}
