"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId, useState, type SyntheticEvent } from "react";

import { IconAlert, IconEye, IconEyeOff } from "@/components/icons";
import { Field } from "@/components/ui";

type Mode = "login" | "signup";

type Props = {
  mode: Mode;
  /** Only ever a same-origin relative path, already validated on the server. */
  next?: string;
};

type FieldErrors = { email?: string; password?: string; form?: string };

const MIN_PASSWORD = 10;

/**
 * Client-side validation exists for feedback only. The API re-validates
 * everything and is the authoritative check.
 *
 * The request contract is unchanged: POST /api/auth/{login|signup} with
 * { email, password, next }, then navigate to the server-provided `next`.
 */
export function AuthForm({ mode, next = "/dashboard" }: Props) {
  const router = useRouter();
  const emailId = useId();
  const passwordId = useId();
  const errorId = useId();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [errors, setErrors] = useState<FieldErrors>({});
  const [submitting, setSubmitting] = useState(false);
  const [reveal, setReveal] = useState(false);

  const isSignup = mode === "signup";

  async function onSubmit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;

    const nextErrors: FieldErrors = {};
    const trimmedEmail = email.trim();
    if (trimmedEmail.length === 0) nextErrors.email = "Email is required.";
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(trimmedEmail)) nextErrors.email = "Enter a valid email address.";

    if (password.length === 0) nextErrors.password = "Password is required.";
    else if (isSignup && password.length < MIN_PASSWORD)
      nextErrors.password = `Use at least ${MIN_PASSWORD} characters.`;

    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;

    setSubmitting(true);
    try {
      const response = await fetch(isSignup ? "/api/auth/signup" : "/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: trimmedEmail, password, next }),
      });
      const data = (await response.json().catch(() => null)) as
        | { ok?: boolean; next?: string; error?: { message?: string } }
        | null;

      if (!response.ok || !data?.ok) {
        setErrors({ form: data?.error?.message ?? `Request failed (${response.status}).` });
        return;
      }

      router.push(data.next ?? "/dashboard");
      router.refresh();
    } catch {
      setErrors({ form: "Network error. Check your connection and try again." });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-5">
      {errors.form ? (
        <div
          id={errorId}
          role="alert"
          className="flex items-start gap-2 rounded-[14px] border border-critical/35 bg-critical/[0.12] px-3.5 py-3 text-[12.5px] leading-5 text-white backdrop-blur-md"
        >
          <IconAlert size={15} className="mt-0.5 shrink-0 text-critical" />
          <span>{errors.form}</span>
        </div>
      ) : null}

      <Field label="Email address" htmlFor={emailId} error={errors.email}>
        <input
          id={emailId}
          name="email"
          type="email"
          inputMode="email"
          autoComplete="email"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          aria-invalid={errors.email ? true : undefined}
          aria-describedby={errors.email ? `${emailId}-error` : undefined}
          className="glass-input"
          placeholder="you@example.com"
        />
      </Field>

      <Field
        label="Password"
        htmlFor={passwordId}
        error={errors.password}
        hint={
          errors.password
            ? undefined
            : isSignup
              ? "Minimum 10 characters. Stored only as an scrypt hash — we cannot read it back."
              : "This build has no password reset flow yet; create a new account if you have lost access."
        }
      >
        <div className="relative">
          <input
            id={passwordId}
            name="password"
            type={reveal ? "text" : "password"}
            autoComplete={isSignup ? "new-password" : "current-password"}
            required
            minLength={isSignup ? MIN_PASSWORD : undefined}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            aria-invalid={errors.password ? true : undefined}
            aria-describedby={errors.password ? `${passwordId}-error` : `${passwordId}-hint`}
            className="glass-input pr-11"
            placeholder={isSignup ? "At least 10 characters" : "Your password"}
          />
          <button
            type="button"
            onClick={() => setReveal((value) => !value)}
            aria-label={reveal ? "Hide password" : "Show password"}
            aria-pressed={reveal}
            className="absolute inset-y-0 right-0 flex w-11 items-center justify-center rounded-r-[14px] text-white/35 transition-colors hover:text-mint"
          >
            {reveal ? <IconEyeOff size={15} /> : <IconEye size={15} />}
          </button>
        </div>
      </Field>

      <button type="submit" disabled={submitting} className="glass-cta">
        {submitting ? (
          <>
            <span className="spinner" aria-hidden="true" />
            {isSignup ? "Creating account…" : "Signing in…"}
          </>
        ) : isSignup ? (
          "Create account"
        ) : (
          "Sign in"
        )}
      </button>

      <p className="text-center text-[12.5px] leading-5 text-white/45">
        {isSignup ? (
          <>
            Already have an account?{" "}
            <Link
              href={`/login?next=${encodeURIComponent(next)}`}
              className="font-medium text-mint underline decoration-mint/30 underline-offset-4 transition-colors hover:decoration-mint"
            >
              Sign in
            </Link>
          </>
        ) : (
          <>
            New to SiteSentra?{" "}
            <Link
              href={`/signup?next=${encodeURIComponent(next)}`}
              className="font-medium text-mint underline decoration-mint/30 underline-offset-4 transition-colors hover:decoration-mint"
            >
              Create an account
            </Link>
          </>
        )}
      </p>
    </form>
  );
}
