import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /** The partner portal and pages became the tenant ones; keep old links working. Temporary while the naming settles. */
  async redirects() {
    return [
      { source: "/partner/tenants", destination: "/tenant/traders", permanent: false },
      { source: "/partner", destination: "/tenant", permanent: false },
      { source: "/partner/:path*", destination: "/tenant/:path*", permanent: false },
      { source: "/partners", destination: "/tenants", permanent: false },
      { source: "/admin/partners", destination: "/admin/tenants", permanent: false },
      // Nasscord has no plans, prices or commission for now: the pages about them are gone, old links land on the area's home.
      { source: "/admin/billing", destination: "/admin", permanent: false },
      { source: "/admin/revenue", destination: "/admin", permanent: false },
      { source: "/tenant/plans", destination: "/tenant", permanent: false },
      { source: "/tenant/payouts", destination: "/tenant", permanent: false },
    ];
  },
};

export default nextConfig;
