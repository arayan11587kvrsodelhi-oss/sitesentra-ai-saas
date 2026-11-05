import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { AuthForm } from "@/components/auth-form";
import { BrandMark } from "@/components/site-header";
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
    <main id="main" className="grid-backdrop flex min-h-screen items-center justify-center px-4 py-12">
      <div className="w-full max-w-md">
        <div className="mb-6 flex items-center gap-2.5 text-mist-100">
          <span className="text-signal-400">
            <BrandMark className="h-7 w-7" />
          </span>
          <Link href="/" className="text-base font-semibold tracking-tight">
            Site<span className="text-signal-400">Sentra</span>
          </Link>
        </div>

        <div className="rounded-xl border border-ink-700 bg-ink-900 p-6 shadow-[0_20px_60px_rgba(0,0,0,0.45)] sm:p-8">
          <h1 className="text-2xl font-semibold tracking-tight text-mist-100">Create your account</h1>
          <p className="mt-2 text-sm text-mist-400">
            Email and password only — no third-party sign-in, no marketing list.
          </p>
          <div className="mt-6">
            <AuthForm mode="signup" next={next} />
          </div>
        </div>

        <div className="mt-6 space-y-2 text-xs leading-relaxed text-mist-500">
          <p>
            We store your email address and an scrypt hash of your password. Nothing else about you is required to use
            the product.
          </p>
          <p>
            Scan reports record the URL you submitted, the observed response metadata and the findings. Set-Cookie
            values are never stored.
          </p>
        </div>
      </div>
    </main>
  );
}
