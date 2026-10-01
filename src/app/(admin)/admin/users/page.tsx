import type { Metadata } from "next";
import { Suspense } from "react";
import { PageHeader } from "@/components/page-header";
import { UsersTable } from "@/components/console/users-table";
import { TableSkeleton } from "@/components/console/primitives";

export const metadata: Metadata = { title: "Users · Console" };

export default function UsersPage() {
  return (
    <>
      <PageHeader title="Users" description="Everyone who can sign in: the super admin, tenants, traders and tenant users. Roles follow where a user belongs." />
      <Suspense fallback={<TableSkeleton rows={8} cols={7} />}>
        <UsersTable />
      </Suspense>
    </>
  );
}
