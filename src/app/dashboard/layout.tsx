import type { ReactNode } from "react";

import { AppChrome } from "@/components/nav";
import { requireUserOrRedirect } from "@/lib/auth/session";
import { checkScanRateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/**
 * Application shell for every signed-in route. Authentication is resolved on
 * the server with the same `requireUserOrRedirect()` guard the pages use, so a
 * client bundle never decides whether someone is signed in.
 */
export default async function DashboardLayout({ children }: { children: ReactNode }) {
  const user = await requireUserOrRedirect();
  const quota = await checkScanRateLimit(user.id);

  return (
    <AppChrome
      email={user.email}
      quota={{ used: quota.used, limit: quota.limit, windowMinutes: quota.windowMinutes }}
    >
      {children}
    </AppChrome>
  );
}
