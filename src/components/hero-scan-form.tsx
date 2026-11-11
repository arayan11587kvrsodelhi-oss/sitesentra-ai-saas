"use client";

import { useRouter } from "next/navigation";
import { useId, useState, type SyntheticEvent } from "react";

import { IconAlert, IconArrowRight, IconScan } from "@/components/icons";
import { normaliseUrlInput } from "@/components/scan-form";

/**
 * Landing-page scan entry.
 *
 * There is no anonymous scan endpoint in this product, and this redesign does
 * not add one. A signed-in visitor is taken to the dashboard with the URL
 * pre-filled there; an anonymous visitor is taken to sign-up carrying the same
 * URL, and lands on the dashboard with it pre-filled after creating an
 * account. Nothing is scanned from the marketing page.
 */
export function HeroScanForm({ signedIn }: { signedIn: boolean }) {
  const router = useRouter();
  const inputId = useId();
  const errorId = `${inputId}-error`;
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  function onSubmit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    const target = normaliseUrlInput(url);
    if (!target) {
      setError("Enter a public website URL, for example https://example.com.");
      return;
    }
    setError(null);
    setPending(true);
    const destination = `/dashboard?url=${encodeURIComponent(target)}`;
    if (signedIn) {
      router.push(destination);
    } else {
      router.push(`/signup?next=${encodeURIComponent(destination)}`);
    }
  }

  return (
    <form onSubmit={onSubmit} noValidate className="mt-8">
      <label htmlFor={inputId} className="sr-only">
        Website to assess
      </label>

      <div
        data-invalid={error ? "true" : undefined}
        className="group relative flex flex-col gap-2 rounded-3xl border border-line-strong bg-panel/90 p-2 shadow-[0_30px_60px_-30px_rgb(0_0_0/0.9)] backdrop-blur transition-colors focus-within:border-mint/70 data-[invalid=true]:border-critical sm:flex-row sm:items-center sm:rounded-full sm:pl-5"
      >
        <span aria-hidden="true" className="mono hidden shrink-0 items-center gap-2.5 pr-4 text-[11.5px] tracking-[0.06em] text-mint uppercase select-none sm:flex">
          <IconScan size={15} />
          https://
        </span>
        <input
          id={inputId}
          name="url"
          type="url"
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          placeholder="yourdomain.com"
          value={url}
          onChange={(event) => {
            setUrl(event.target.value);
            if (error) setError(null);
          }}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          className="mono h-12 w-full min-w-0 flex-1 border-0 bg-transparent px-3 text-[14px] text-fg placeholder:font-sans placeholder:text-faint focus:outline-none sm:px-0"
        />
        <button
          type="submit"
          disabled={pending}
          className="btn btn-primary h-12 shrink-0 gap-2 px-6 sm:min-w-[11rem]"
        >
          {pending ? <span className="spinner" aria-hidden="true" /> : null}
          {signedIn ? "Run check" : "Scan this site"}
          {!pending ? <IconArrowRight size={15} /> : null}
        </button>
      </div>

      {error ? (
        <p id={errorId} role="alert" className="mt-2.5 flex items-center gap-2 text-[12px] text-critical">
          <IconAlert size={14} className="shrink-0" />
          {error}
        </p>
      ) : (
        <p className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px] leading-5 text-faint">
          <span className="inline-flex items-center gap-1.5">
            <span aria-hidden="true" className="size-1.5 rounded-full bg-pass" />
            Free account
          </span>
          <span aria-hidden="true" className="text-line-strong">·</span>
          <span>{signedIn ? "Your URL goes straight to the scanner." : "Email and password only — your URL is carried to the scanner once you sign in."}</span>
        </p>
      )}
    </form>
  );
}
