/**
 * SiteSentra UI primitives.
 *
 * One vocabulary, used by every page: buttons, panels, badges, fields, KPI
 * tiles, the severity distribution, empty/error states. Nothing here talks to
 * the network or reads the session — these are presentation only, so they can
 * be used from server components.
 */
import type { ComponentPropsWithoutRef, ReactNode } from "react";
import Link from "next/link";

// ---------------------------------------------------------------------------
// Button
// ---------------------------------------------------------------------------

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
type ButtonSize = "sm" | "md" | "lg";

const BUTTON_VARIANT: Record<ButtonVariant, string> = {
  primary: "btn-primary",
  secondary: "btn-secondary",
  ghost: "btn-ghost",
  danger: "btn-danger",
};

const BUTTON_SIZE: Record<ButtonSize, string> = {
  sm: "btn-sm",
  md: "",
  lg: "btn-lg",
};

function buttonClass(variant: ButtonVariant, size: ButtonSize, className = "") {
  return ["btn", BUTTON_VARIANT[variant], BUTTON_SIZE[size], className].filter(Boolean).join(" ");
}

export function Button({
  variant = "secondary",
  size = "md",
  className = "",
  children,
  ...props
}: ComponentPropsWithoutRef<"button"> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  children: ReactNode;
}) {
  return (
    <button className={buttonClass(variant, size, className)} {...props}>
      {children}
    </button>
  );
}

/** A link that looks like a button — always a real navigation, never an action. */
export function ButtonLink({
  href,
  variant = "primary",
  size = "md",
  className = "",
  children,
  ...props
}: Omit<ComponentPropsWithoutRef<typeof Link>, "href"> & {
  href: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  children: ReactNode;
}) {
  return (
    <Link href={href} className={buttonClass(variant, size, className)} {...props}>
      {children}
    </Link>
  );
}

// ---------------------------------------------------------------------------
// Panels
// ---------------------------------------------------------------------------

export function Panel({
  children,
  className = "",
  as: Tag = "section",
  id,
}: {
  children: ReactNode;
  className?: string;
  as?: "section" | "div" | "article" | "aside";
  /** Anchor target for in-page navigation. */
  id?: string;
}) {
  return (
    <Tag id={id} className={`panel ${className}`}>
      {children}
    </Tag>
  );
}

/**
 * Panel header. The title is a real heading and the optional `meta` is a
 * short machine caption; `action` holds at most one control.
 */
export function PanelHeader({
  title,
  meta,
  action,
  eyebrow,
  className = "",
  divider = true,
}: {
  title: ReactNode;
  meta?: ReactNode;
  action?: ReactNode;
  eyebrow?: ReactNode;
  className?: string;
  divider?: boolean;
}) {
  return (
    <div
      className={`flex flex-wrap items-start justify-between gap-x-4 gap-y-2 px-5 pt-5 ${divider ? "pb-4" : "pb-1"} ${divider ? "border-b border-line" : ""
        } ${className}`}
    >
      <div className="min-w-0">
        {eyebrow ? <p className="eyebrow-accent mb-1.5">{eyebrow}</p> : null}
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h2 className="h3">{title}</h2>
          {meta ? <span className="mono text-[11px] text-faint">{meta}</span> : null}
        </div>
      </div>
      {action ? <div className="flex shrink-0 items-center gap-2">{action}</div> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Badges
// ---------------------------------------------------------------------------

type Tone = "critical" | "high" | "medium" | "low" | "pass" | "info" | "neutral" | "brand";

const TONE_BADGE: Record<Tone, string> = {
  critical: "border-critical/30 bg-critical/10 text-critical",
  high: "border-high/30 bg-high/10 text-high",
  medium: "border-medium/30 bg-medium/10 text-medium",
  low: "border-low/30 bg-low/10 text-low",
  pass: "border-pass/30 bg-pass/10 text-pass",
  info: "border-info/25 bg-info/10 text-info",
  neutral: "border-line-strong bg-inset text-muted",
  brand: "border-line-teal bg-mint-soft text-mint",
};

/** Status pill with a leading dot — the standard way to show an outcome. */
export function Badge({
  tone = "neutral",
  children,
  className = "",
  title,
  dot = false,
}: {
  tone?: Tone;
  children: ReactNode;
  className?: string;
  title?: string;
  dot?: boolean;
}) {
  return (
    <span
      title={title}
      className={`mono inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10.5px] leading-4 font-medium tracking-[0.03em] whitespace-nowrap ${TONE_BADGE[tone]} ${className}`}
    >
      {dot ? <span aria-hidden="true" className={`size-1.5 rounded-full ${DOT_FILL[tone]}`} /> : null}
      {children}
    </span>
  );
}

/** Small square swatch that carries the severity colour, used in dense rows. */
export function SeverityDot({ tone, className = "" }: { tone: Tone; className?: string }) {
  return <span aria-hidden="true" className={`inline-block size-1.5 shrink-0 rounded-[2px] ${DOT_FILL[tone]} ${className}`} />;
}

const DOT_FILL: Record<Tone, string> = {
  critical: "bg-critical",
  high: "bg-high",
  medium: "bg-medium",
  low: "bg-low",
  pass: "bg-pass",
  info: "bg-info",
  neutral: "bg-faint",
  brand: "bg-mint",
};

// ---------------------------------------------------------------------------
// Field
// ---------------------------------------------------------------------------

export function Field({
  label,
  hint,
  error,
  htmlFor,
  children,
  className = "",
}: {
  label: string;
  hint?: ReactNode;
  error?: ReactNode;
  htmlFor: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`space-y-1.5 ${className}`}>
      <label htmlFor={htmlFor} className="flex items-baseline justify-between gap-2 text-[12px] font-medium text-soft">
        <span>{label}</span>
      </label>
      {children}
      {error ? (
        <p role="alert" className="text-[11.5px] leading-5 text-critical">
          {error}
        </p>
      ) : hint ? (
        <p className="text-[11px] leading-5 text-faint">{hint}</p>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// KPI tile
// ---------------------------------------------------------------------------

/**
 * A compact metric: label, large figure, caption, and an optional mini meter
 * so the number has a scale next to it. The meter is omitted when there is no
 * meaningful denominator — a bar at 0% would be a claim of its own.
 */
export function Stat({
  label,
  value,
  detail,
  tone = "default",
  icon,
  meter,
  size = "md",
}: {
  label: string;
  value: ReactNode;
  detail?: ReactNode;
  tone?: "default" | "critical" | "high" | "medium" | "pass" | "info";
  icon?: ReactNode;
  /** 0–1. Renders a hairline meter under the value. */
  meter?: number;
  size?: "md" | "lg";
}) {
  const tones: Record<string, string> = {
    default: "text-fg",
    critical: "text-critical",
    high: "text-high",
    medium: "text-medium",
    pass: "text-pass",
    info: "text-info",
  };
  return (
    <div className="group relative flex h-full flex-col justify-between gap-4 p-4 transition-colors sm:p-5">
      <div className="flex items-start justify-between gap-3">
        <p className="text-[12px] leading-4 font-medium text-muted">{label}</p>
        {icon ? (
          <span className="flex size-7 shrink-0 items-center justify-center rounded-full border border-line bg-inset text-teal">
            {icon}
          </span>
        ) : null}
      </div>
      <div>
        <p className={`figure ${size === "lg" ? "text-[2rem] leading-none" : "text-[1.75rem] leading-none"} ${tones[tone]}`}>
          {value}
        </p>
        {meter !== undefined ? (
          <div className="mt-3 h-1 w-full overflow-hidden rounded-full bg-inset" aria-hidden="true">
            <span
              className={`block h-full rounded-full ${tone === "critical" ? "bg-critical" : tone === "pass" ? "bg-mint" : "bg-teal"}`}
              style={{ width: `${Math.max(0, Math.min(1, meter)) * 100}%` }}
            />
          </div>
        ) : null}
        {detail ? <p className="mt-2 text-[11.5px] leading-5 text-faint">{detail}</p> : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Distribution — severity counts as one proportional bar + a legend row
// ---------------------------------------------------------------------------

export type DistributionItem = {
  key: string;
  label: string;
  count: number;
  tone: Tone;
};

export function DistributionBar({
  items,
  showLegend = true,
  height = 10,
  label = "Severity distribution",
}: {
  items: DistributionItem[];
  showLegend?: boolean;
  height?: number;
  label?: string;
}) {
  const total = items.reduce((sum, item) => sum + item.count, 0);
  const present = items.filter((item) => item.count > 0);

  return (
    <div>
      <div
        className="flex w-full gap-px overflow-hidden rounded-full bg-black/60 ring-1 ring-inset ring-line-strong/30"
        style={{ height }}
        role="img"
        aria-label={`${label}: ${items.map((i) => `${i.label} ${i.count}`).join(", ")}`}
      >
        {total === 0 ? (
          <span className="h-full w-full rounded-full bg-black/40 ring-1 ring-inset ring-line-strong/30" />
        ) : (
          present.map((item) => (
            <span
              key={item.key}
              className={`${DOT_FILL[item.tone]}`}
              style={{ width: `${(item.count / total) * 100}%` }}
            />
          ))
        )}
      </div>
      {showLegend ? (
        <ul className="mt-4 grid grid-cols-3 gap-x-3 gap-y-2.5 sm:grid-cols-5">
          {items.map((item) => (
            <li key={item.key}>
              <span className="flex items-center gap-1.5">
                <SeverityDot tone={item.tone} />
                <span className="mono truncate text-[9.5px] tracking-[0.04em] text-faint uppercase">{item.label}</span>
              </span>
              <span className="mono mt-0.5 block text-[13px] leading-4 font-medium text-soft tabular-nums">
                {item.count}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// States
// ---------------------------------------------------------------------------

export function EmptyState({
  icon,
  title,
  description,
  action,
  className = "",
}: {
  icon?: ReactNode;
  title: string;
  description: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={`relative px-6 py-14 text-center ${className}`}>
      <div aria-hidden="true" className="dot-grid pointer-events-none absolute inset-0 opacity-25 [mask-image:radial-gradient(60%_60%_at_50%_40%,#000,transparent)]" />
      <div className="relative">
        {icon ? (
          <div className="mx-auto mb-4 flex size-11 items-center justify-center rounded-full border border-line-teal bg-teal/40 text-mint">
            {icon}
          </div>
        ) : null}
        <p className="h3">{title}</p>
        <p className="mx-auto mt-1.5 max-w-sm text-[12.5px] leading-6 text-muted">{description}</p>
        {action ? <div className="mt-5 flex justify-center">{action}</div> : null}
      </div>
    </div>
  );
}

export function InlineAlert({
  tone = "info",
  title,
  children,
  className = "",
}: {
  tone?: "info" | "warning" | "error" | "success";
  title?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const tones = {
    info: "border-line-teal bg-teal/30 text-soft",
    warning: "border-medium/30 bg-medium/[0.06] text-fg",
    error: "border-critical/30 bg-critical/[0.06] text-fg",
    success: "border-pass/30 bg-pass/[0.06] text-fg",
  } as const;
  return (
    <div role={tone === "error" ? "alert" : "status"} className={`rounded-xl border px-4 py-3 ${tones[tone]} ${className}`}>
      {title ? <p className="text-[12.5px] font-medium tracking-[0.01em]">{title}</p> : null}
      <div className={`text-[12.5px] leading-5 ${title ? "mt-1" : ""}`}>{children}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Code / data display
// ---------------------------------------------------------------------------

export function DataWell({
  children,
  className = "",
  scroll = true,
}: {
  children: ReactNode;
  className?: string;
  scroll?: boolean;
}) {
  return (
    <pre
      className={`well evidence-value m-0 px-3 py-2.5 ${scroll ? "max-h-80 overflow-auto" : ""} ${className}`}
    >
      {children}
    </pre>
  );
}

/** Label/value pair used inside evidence lists. Values wrap, never overflow. */
export function EvidenceRow({
  label,
  value,
  status,
}: {
  label: string;
  value: string;
  status?: "ok" | "bad" | "warn" | "neutral";
}) {
  const marker =
    status === "ok" ? "text-pass" : status === "bad" ? "text-critical" : status === "warn" ? "text-medium" : "text-faint";
  return (
    <div className="grid gap-0.5 border-b border-line/70 px-3 py-2.5 last:border-b-0 md:grid-cols-[minmax(7rem,11rem)_minmax(0,1fr)] md:gap-4">
      <dt className={`text-[10.5px] leading-5 font-medium tracking-[0.08em] uppercase md:pt-px ${marker}`}>{label}</dt>
      <dd className="evidence-value min-w-0">{value}</dd>
    </div>
  );
}
