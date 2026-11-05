# SiteSentra — Website Security Intelligence

SiteSentra sends **one unauthenticated HTTP(S) request** to a public website and reports the
security configuration it actually observed: HTTPS availability, TLS handshake facts, HTTP
security headers, and cookie attributes — each with raw evidence, a remediation step, and an
explicit statement of what the check **cannot** tell you.

It is a configuration-observation tool. **It is not a penetration test**, it does not scan for
vulnerabilities, and a clean report never proves a website is secure.

---

## What it does

| Capability | Where |
| --- | --- |
| Email/password registration, login, logout | `src/app/api/auth/*`, `src/lib/auth/*` |
| URL submission with SSRF/abuse policy enforcement | `src/lib/scanner/target-guard.ts` |
| Real HTTPS + TLS observation, HTTP→HTTPS upgrade check | `src/lib/scanner/http-client.ts` |
| Evidence-backed findings with remediation + limitations | `src/lib/scanner/analyze.ts` |
| Per-user scan history and report detail | `src/app/dashboard/*` |
| Cross-user isolation (SQL predicate **and** RLS policies) | `src/app/api/scans/[id]/route.ts`, `supabase/schema.sql` |
| Responsive, accessible dark UI | `src/components/*`, `src/app/globals.css` |

14 checks are recorded per scan: HTTPS availability, HTTP→HTTPS redirect, TLS certificate,
TLS protocol version, HSTS, CSP (parsed for `unsafe-inline`/`unsafe-eval`/wildcards),
`X-Content-Type-Options`, `Referrer-Policy`, framing protection, `Permissions-Policy`,
cookie attributes, server disclosure, cross-origin isolation headers, and the standing
scope/limitation notice.

Every finding has one of six honest statuses: `pass`, `fail`, `warn`, `info`,
`not_applicable`, `inconclusive`. There is no numeric "security score", because a score would
imply a guarantee we cannot make.

---

## Stack

- **Next.js 16 (App Router) + TypeScript + Tailwind CSS 4**
- **PostgreSQL** via **Drizzle ORM** (`src/db`)
- **Zero added runtime dependencies.** Authentication, password hashing, session tokens and the
  scanner are implemented on Node built-ins (`node:crypto`, `node:https`, `node:dns`, `node:net`).
- Tests run on **Node's built-in test runner** (`node --test`) — no test framework was added.

### Note on Supabase (read this)

The brief specifies Supabase for auth and Postgres. This environment provides a PostgreSQL
server and Drizzle, but **no Supabase project or credentials**, so the running application uses
a server-side session implementation with equivalent guarantees:

- scrypt password hashing (N=16384, r=8, p=1, 64-byte key, per-password salt)
- opaque 256-bit session tokens, stored **only as SHA-256 digests**
- HttpOnly + SameSite=Lax cookies, Secure whenever the request arrived over HTTPS
- identity always derived server-side from the session, never from a client-supplied id

`supabase/schema.sql` contains the same schema **plus** Row Level Security policies written
against `auth.uid()`, so the database layer can be moved to Supabase Postgres without rewriting
the security model. `.env.example` documents the Supabase variables and which ones are
privileged. Swapping the session layer for `@supabase/ssr` is a contained change in
`src/lib/auth/` and is the recommended next step if Supabase credentials become available.

---

## Running it locally

```powershell
# 1. Install dependencies
npm install

# 2. Configure the environment (never commit the real file)
Copy-Item .env.example .env.local
# then edit .env.local — placeholders only live in .env.example

# 3. Create/refresh the database schema
npx drizzle-kit push

# 4. Apply Row Level Security (idempotent; safe to re-run)
psql "$env:DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/schema.sql

# 5. Develop
npm run dev
```

### Verification commands

```powershell
npm exec tsc -- --noEmit          # TypeScript
npm run lint                      # ESLint
npm run build                     # production build

# Unit tests (Node's built-in runner; PowerShell does not expand globs, so list files)
node --test tests/target-guard.test.ts tests/analyze.test.ts tests/password.test.ts tests/origin-policy.test.ts tests/attempt-limit.test.ts tests/tenant-isolation.test.ts

# Database isolation test (needs a reachable DATABASE_URL)
psql "$env:DATABASE_URL" -v ON_ERROR_STOP=1 -f tests/rls-isolation.sql

# End-to-end test against a running server
npm run start                     # or: npm run dev
node scripts/smoke.mjs            # or: $env:BASE_URL="https://your-preview"; node scripts/smoke.mjs
```

---

## Environment variables

See `.env.example` for the full annotated list. Highlights:

| Variable | Purpose | Sensitive? |
| --- | --- | --- |
| `DATABASE_URL` | PostgreSQL connection string | yes (server-only) |
| `SESSION_TTL_SECONDS` | Session lifetime (default 7 days) | no |
| `AUTH_RATE_LIMIT_WINDOW_MINUTES` | Login/signup throttle window (default 15) | no |
| `AUTH_LOGIN_MAX_PER_WINDOW` | Login attempts per window, per account and per address (default 10) | no |
| `AUTH_SIGNUP_MAX_PER_WINDOW` | Signup attempts per window, per account and per address (default 20) | no |
| `SCAN_RATE_LIMIT_MAX_PER_WINDOW` | Scans per user per window (default 12) | no |
| `SCAN_RATE_LIMIT_WINDOW_MINUTES` | Window length (default 60) | no |
| `SCANNER_MAX_CONCURRENT_REQUESTS` | Global outbound request cap (default 3) | no |
| `SCANNER_CONNECT_TIMEOUT_MS` / `SCANNER_TOTAL_TIMEOUT_MS` / `SCANNER_SCAN_BUDGET_MS` | Timeouts | no |
| `SCANNER_MAX_RESPONSE_BYTES` | Body cap before the socket is destroyed | no |

`.env`, `.env.local` and every `.env.*` except `.env.example` are git-ignored.

---

## Deployment (Vercel via GitHub)

1. Push the repository to GitHub.
2. Import it in Vercel (framework: Next.js, no custom build settings needed).
3. Set `DATABASE_URL` in **Production** and **Preview** separately. Development, preview and
   production should point at different databases — a preview deployment writing to production
   data is an incident waiting to happen.
4. Never add a service-role or secret key as a `NEXT_PUBLIC_*` variable.
5. After deploying, re-run `node scripts/smoke.mjs` against the production URL. A successful
   deployment is not proof of security; the smoke test is.

---

## Project layout

```
src/
  app/                  # routes: landing, login, signup, dashboard, report, methodology, api/
  components/           # UI (server + client components)
  db/                   # Drizzle client + schema
  lib/
    auth/               # password hashing, sessions, CSRF/origin checks
    scanner/
      target-guard.ts   # SSRF boundary: URL policy, IP classification, DNS pinning, redirects
      http-client.ts    # hardened outbound client: timeouts, size caps, semaphore
      analyze.ts        # pure finding analysis from observations
      run-scan.ts       # orchestration, quota, redaction, persistence
    http.ts             # route-handler helpers (body cap, error shaping)
    rate-limit.ts       # durable quota + in-process concurrency
scripts/smoke.mjs       # end-to-end security test against a live server
supabase/schema.sql     # schema + RLS policies (idempotent)
tests/                  # unit tests (node --test) and the RLS isolation SQL test
docs/SECURITY.md        # threat model, controls, known limitations
STAGE_LOG.md            # what was built/verified at each stage
```

## Acceptable use

Only scan websites you own or have explicit permission to test. SiteSentra performs a passive
configuration read and grants no authority to test third-party systems.
