import type { ReactNode } from "react";

import { formatDate } from "@/components/severity";

/**
 * Page band inside the app shell: eyebrow, title, one-line description, the
 * page's primary action and an optional strip of metadata. Not sticky — the
 * shell's top bar carries the persistent actions, so this band can scroll away
 * and leave the content in view.
 */
export function PageHeader({
  eyebrow,
  title,
  description,
  meta,
  actions,
  className = "",
}: {
  eyebrow?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div className={`border-b border-line ${className}`}>
      <div className="flex flex-col gap-4 px-[var(--gutter)] pt-6 pb-6 sm:flex-row sm:items-end sm:justify-between sm:gap-8 lg:pt-8">
        <div className="min-w-0">
          {eyebrow ? <div className="mb-3 flex items-center gap-2.5">{eyebrow}</div> : null}
          <h1 className="h1">{title}</h1>
          {description ? <p className="mt-2 max-w-2xl text-[13px] leading-6 text-muted">{description}</p> : null}
          {meta ? <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5">{meta}</div> : null}
        </div>
        {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
    </div>
  );
}

export function MetaItem({ label, value, mono = true }: { label: string; value: ReactNode; mono?: boolean }) {
  return (
    <span className="inline-flex items-baseline gap-1.5 text-[12px]">
      <span className="text-faint">{label}</span>
      <span className={mono ? "mono text-soft" : "text-soft"}>{value}</span>
    </span>
  );
}

export function Timestamp({ value }: { value: Date | string | null | undefined }) {
  const day = value ? (typeof value === "string" ? new Date(value) : value).toISOString().slice(0, 10) : null;
  return (
    <time dateTime={day ?? undefined} title={formatDate(value)} className="mono text-[12px] text-soft">
      {formatDate(value)}
    </time>
  );
}
