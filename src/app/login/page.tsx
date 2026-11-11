import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { AuthForm } from "@/components/auth-form";
import { AuthShell } from "@/components/auth-shell";
import { getCurrentUser } from "@/lib/auth/session";
import { safeRedirectPath } from "@/lib/auth/password";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Sign in" };

type Props = { searchParams: Promise<{ next?: string }> };

export default async function LoginPage({ searchParams }: Props) {
  const user = await getCurrentUser();
  const params = await searchParams;
  const next = safeRedirectPath(params.next, "/dashboard");

  // Already signed in: never bounce through the login form.
  if (user) redirect(next);

  return (
    <AuthShell
      eyebrow="Welcome back"
      title="Sign in"
      description="Access your scan history and run new website security configuration checks."
      side={{
        eyebrow: "How sessions work",
        heading: "Your reports stay private to your account.",
        points: [
          {
            icon: "lock",
            text: "Sessions use an HttpOnly, SameSite cookie. Only a hash of the session token is stored in the database.",
          },
          {
            icon: "shield",
            text: "Passwords are hashed with scrypt and never stored in plaintext.",
          },
          {
            icon: "terminal",
            text: "Scan reports record the URL you submitted, observed response metadata and findings. Set-Cookie values are never stored.",
          },
        ],
      }}
      altAction={{ href: "/signup", label: "No account yet?", cta: "Create one" }}
      footer="Signed in only on this device. Sign out from the workspace panel when you are finished."
    >
      <AuthForm mode="login" next={next} />
    </AuthShell>
  );
}
