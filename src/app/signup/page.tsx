import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { AuthForm } from "@/components/auth-form";
import { AuthShell } from "@/components/auth-shell";
import { getCurrentUser } from "@/lib/auth/session";
import { safeRedirectPath } from "@/lib/auth/password";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Create account" };

type Props = { searchParams: Promise<{ next?: string }> };

export default async function SignupPage({ searchParams }: Props) {
  const user = await getCurrentUser();
  const params = await searchParams;
  const next = safeRedirectPath(params.next, "/dashboard");

  if (user) redirect(next);

  return (
    <AuthShell
      eyebrow="Create account"
      title="Create your account"
      description="Email and password only — no third-party sign-in, no marketing list."
      side={{
        eyebrow: "What you get",
        heading: "Evidence-backed configuration reports, private to you.",
        points: [
          {
            icon: "shield",
            text: "HTTPS, TLS, security-header and cookie-attribute observations from one unauthenticated request per origin.",
          },
          {
            icon: "terminal",
            text: "Every finding shows the raw observed value, a remediation step, and what the check cannot prove.",
          },
          {
            icon: "lock",
            text: "We store your email address and an scrypt hash of your password. Nothing else about you is required.",
          },
        ],
      }}
      altAction={{ href: "/login", label: "Already registered?", cta: "Sign in" }}
      footer="Scan reports record the URL you submitted, the observed response metadata and the findings. Set-Cookie values are never stored."
    >
      <AuthForm mode="signup" next={next} />
    </AuthShell>
  );
}
