"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId, useState, type FormEvent } from "react";

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

  const isSignup = mode === "signup";

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
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
          className="rounded-md border border-bad-400/40 bg-bad-400/10 px-4 py-3 text-sm text-bad-400"
        >
          {errors.form}
        </div>
      ) : null}

      <div className="space-y-2">
        <label htmlFor={emailId} className="block text-sm font-medium text-mist-200">
          Email address
        </label>
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
          className="w-full rounded-md border border-ink-600 bg-ink-950 px-3.5 py-2.5 text-mist-100 placeholder:text-mist-500 focus:border-signal-400"
          placeholder="you@example.com"
        />
        {errors.email ? (
          <p id={`${emailId}-error`} className="text-sm text-bad-400">
            {errors.email}
          </p>
        ) : null}
      </div>

      <div className="space-y-2">
        <label htmlFor={passwordId} className="block text-sm font-medium text-mist-200">
          Password
        </label>
        <input
          id={passwordId}
          name="password"
          type="password"
          autoComplete={isSignup ? "new-password" : "current-password"}
          required
          minLength={isSignup ? MIN_PASSWORD : undefined}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          aria-invalid={errors.password ? true : undefined}
          aria-describedby={errors.password ? `${passwordId}-error` : `${passwordId}-hint`}
          className="w-full rounded-md border border-ink-600 bg-ink-950 px-3.5 py-2.5 text-mist-100 placeholder:text-mist-500 focus:border-signal-400"
          placeholder={isSignup ? "At least 10 characters" : "Your password"}
        />
        {errors.password ? (
          <p id={`${passwordId}-error`} className="text-sm text-bad-400">
            {errors.password}
          </p>
        ) : (
          <p id={`${passwordId}-hint`} className="text-sm text-mist-500">
            {isSignup
              ? "Minimum 10 characters. Stored only as an scrypt hash — we cannot read it back."
              : "Forgot your password? This MVP has no reset flow yet; create a new account with a different email."}
          </p>
        )}
      </div>

      <button
        type="submit"
        disabled={submitting}
        className="w-full rounded-md bg-signal-500 px-4 py-2.5 text-sm font-semibold text-ink-950 transition-colors hover:bg-signal-400 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {submitting ? "Please wait…" : isSignup ? "Create account" : "Sign in"}
      </button>

      <p className="text-sm text-mist-400">
        {isSignup ? (
          <>
            Already have an account?{" "}
            <Link href={`/login?next=${encodeURIComponent(next)}`} className="text-signal-300 underline">
              Sign in
            </Link>
          </>
        ) : (
          <>
            New to SiteSentra?{" "}
            <Link href={`/signup?next=${encodeURIComponent(next)}`} className="text-signal-300 underline">
              Create an account
            </Link>
          </>
        )}
      </p>
    </form>
  );
}
