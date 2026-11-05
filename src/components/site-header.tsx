import Link from "next/link";

import { SignOutButton } from "@/components/sign-out-button";

export function BrandMark({ className = "h-8 w-8" }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden="true" focusable="false">
      <path
        d="M16 2.5 27 6.8v8.4c0 6.6-4.4 12.1-11 14.3-6.6-2.2-11-7.7-11-14.3V6.8L16 2.5Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path
        d="m11.4 16.1 3.2 3.3 6.1-6.6"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

type Props = {
  user: { email: string } | null;
};

/**
 * Site header. Rendered on the server with the session-derived user, so the
 * client bundle never decides whether someone is signed in.
 */
export function SiteHeader({ user }: Props) {
  return (
    <header className="sticky top-0 z-40 border-b border-ink-700/70 bg-ink-950/85 backdrop-blur">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-3 px-4 py-3 sm:px-6">
        <Link href="/" className="flex items-center gap-2.5 text-mist-100">
          <span className="text-signal-400">
            <BrandMark />
          </span>
          <span className="text-base font-semibold tracking-tight">
            Site<span className="text-signal-400">Sentra</span>
          </span>
        </Link>

        <nav aria-label="Main" className="ml-auto flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
          <Link href="/methodology" className="text-mist-400 transition-colors hover:text-mist-100">
            Methodology
          </Link>
          {user ? (
            <>
              <Link href="/dashboard" className="text-mist-400 transition-colors hover:text-mist-100">
                Dashboard
              </Link>
              <span className="hidden max-w-[16rem] truncate text-mist-500 sm:inline" title={user.email}>
                {user.email}
              </span>
              <SignOutButton />
            </>
          ) : (
            <>
              <Link href="/login" className="text-mist-400 transition-colors hover:text-mist-100">
                Sign in
              </Link>
              <Link
                href="/signup"
                className="rounded-md border border-signal-400/40 bg-signal-400/10 px-3 py-1.5 font-medium text-signal-300 transition-colors hover:bg-signal-400/20"
              >
                Create account
              </Link>
            </>
          )}
        </nav>
      </div>
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="border-t border-ink-700/70 bg-ink-950">
      <div className="mx-auto max-w-6xl px-4 py-8 text-sm text-mist-500 sm:px-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="max-w-xl space-y-2">
            <p className="font-medium text-mist-300">SiteSentra — Website Security Intelligence</p>
            <p>
              Reports describe configuration that was <em>observed</em> during one unauthenticated request. They are not
              penetration tests and never prove that a website is secure.
            </p>
          </div>
          <nav aria-label="Footer" className="flex flex-col gap-2">
            <Link href="/methodology" className="hover:text-mist-200">
              Methodology &amp; limitations
            </Link>
            <Link href="/dashboard" className="hover:text-mist-200">
              Your scans
            </Link>
          </nav>
        </div>
      </div>
    </footer>
  );
}
