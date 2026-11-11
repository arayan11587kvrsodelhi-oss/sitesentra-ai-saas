import Link from "next/link";

/**
 * Brand mark: an aperture over a shield — the scan looking at a site. Drawn
 * inline so it costs no request and inherits `currentColor`.
 */
export function BrandMark({ className = "size-5" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true" focusable="false">
      <path
        d="M12 2.4 20 5.4v6.2c0 4.9-3.3 9.1-8 10.7-4.7-1.6-8-5.8-8-10.7V5.4z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="11.2" r="2.6" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <path d="M12 8.6v-1M12 14.8v1M9.4 11.2h-1M15.6 11.2h1" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

export function Brand({
  href = "/",
  className = "",
  compact = false,
  onNavigate,
  tone = "default",
}: {
  href?: string;
  className?: string;
  compact?: boolean;
  /** Lets the mobile drawer close itself when the brand is used to navigate. */
  onNavigate?: () => void;
  /** "invert" is used on the deep-teal sidebar, where the tile is mint. */
  tone?: "default" | "invert";
}) {
  return (
    <Link
      href={href}
      onClick={onNavigate}
      className={`group inline-flex items-center gap-2.5 rounded-full text-fg focus-visible:outline-none ${className}`}
      aria-label="SiteSentra home"
    >
      <span
        className={`flex size-8 items-center justify-center rounded-[10px] transition-transform group-hover:scale-[1.04] ${
          tone === "invert"
            ? "bg-mint text-[#02241f] shadow-[0_4px_14px_-6px_rgb(17_201_182/0.9)]"
            : "border border-line-teal bg-teal text-mint"
        }`}
      >
        <BrandMark />
      </span>
      <span className="flex flex-col leading-none">
        <span className={`text-[15px] font-semibold tracking-[-0.02em] ${compact ? "sr-only" : ""}`}>SiteSentra</span>
        {!compact ? (
          <span className="mono mt-1 text-[9px] tracking-[0.18em] text-mint/70 uppercase">Header intelligence</span>
        ) : null}
      </span>
    </Link>
  );
}
