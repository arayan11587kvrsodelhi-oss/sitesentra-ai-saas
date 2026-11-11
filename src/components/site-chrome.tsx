import Link from "next/link";

import { Brand } from "@/components/brand";
import { IconArrowRight } from "@/components/icons";

/**
 * Public header. Deliberately not a client component: navigation here is
 * plain links, and on narrow screens the secondary links collapse into a row
 * of text links instead of a menu that needs JavaScript.
 */
export function PublicHeader({ signedIn }: { signedIn: boolean }) {
  return (
    <header className="sticky top-0 z-40 border-b border-line bg-base/80 backdrop-blur-xl">
      <div className="page flex h-16 items-center justify-between gap-4">
        <div className="flex items-center gap-8">
          <Brand />
          <nav aria-label="Product" className="hidden items-center gap-1 text-[13px] md:flex">
            <Link href="/#workflow" className="rounded-full px-3 py-1.5 text-muted transition-colors hover:bg-inset hover:text-fg">
              Product
            </Link>
            <Link href="/#capabilities" className="rounded-full px-3 py-1.5 text-muted transition-colors hover:bg-inset hover:text-fg">
              Capabilities
            </Link>
            <Link href="/methodology" className="rounded-full px-3 py-1.5 text-muted transition-colors hover:bg-inset hover:text-fg">
              Methodology
            </Link>
          </nav>
        </div>

        <div className="flex items-center gap-1.5 sm:gap-2">
          {signedIn ? (
            <Link href="/dashboard" className="btn btn-primary btn-sm gap-1.5">
              Open dashboard
              <IconArrowRight size={14} />
            </Link>
          ) : (
            <>
              <Link href="/login" className="btn btn-ghost btn-sm">
                Sign in
              </Link>
              <Link href="/signup" className="btn btn-primary btn-sm gap-1.5">
                Start free scan
                <IconArrowRight size={14} />
              </Link>
            </>
          )}
        </div>
      </div>
    </header>
  );
}

export function PublicFooter() {
  return (
    <footer className="border-t border-line">
      <div className="page py-12">
        <div className="grid gap-10 sm:grid-cols-[1.6fr_1fr_1fr]">
          <div>
            <Brand />
            <p className="mt-4 max-w-sm text-[12px] leading-5 text-muted">
              Evidence-based website security configuration assessment. Reports describe what was observed during one
              unauthenticated request — they are not penetration tests.
            </p>
            <p className="mono mt-4 inline-flex items-center gap-2 rounded-full border border-line-teal bg-teal/30 px-2.5 py-1 text-[10px] tracking-[0.08em] text-mint uppercase">
              <span className="size-1.5 rounded-full bg-mint" />
              Configuration observation
            </p>
          </div>

          <nav aria-label="Product links">
            <p className="mono mb-3 text-[10px] tracking-[0.14em] text-faint uppercase">Product</p>
            <ul className="space-y-2 text-[13px]">
              <li>
                <Link href="/#workflow" className="text-soft transition-colors hover:text-mint">
                  How a check runs
                </Link>
              </li>
              <li>
                <Link href="/#capabilities" className="text-soft transition-colors hover:text-mint">
                  Capabilities
                </Link>
              </li>
              <li>
                <Link href="/dashboard" className="text-soft transition-colors hover:text-mint">
                  Your scans
                </Link>
              </li>
            </ul>
          </nav>

          <nav aria-label="Trust links">
            <p className="mono mb-3 text-[10px] tracking-[0.14em] text-faint uppercase">Trust</p>
            <ul className="space-y-2 text-[13px]">
              <li>
                <Link href="/methodology" className="text-soft transition-colors hover:text-mint">
                  Methodology &amp; limitations
                </Link>
              </li>
              <li>
                <Link href="/methodology#acceptable-use" className="text-soft transition-colors hover:text-mint">
                  Acceptable use
                </Link>
              </li>
              <li>
                <Link href="/login" className="text-soft transition-colors hover:text-mint">
                  Sign in
                </Link>
              </li>
            </ul>
          </nav>
        </div>

        <div className="mt-10 flex flex-col gap-2 border-t border-line pt-5 text-[11px] text-faint sm:flex-row sm:items-center sm:justify-between">
          <p>© {new Date().getFullYear()} SiteSentra. Configuration observation only — not a security certification.</p>
          <p className="mono">Only scan sites you own or are authorised to test.</p>
        </div>
      </div>
    </footer>
  );
}
