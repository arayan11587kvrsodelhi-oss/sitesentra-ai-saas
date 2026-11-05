# SiteSentra — stage log

Every entry records: files changed, commands actually run, observed results, security
limitations, and dependencies added. Nothing below is claimed unless it was executed and seen.

**Dependencies added: none.** The entire application runs on Next.js, React, Drizzle, `pg` and
Node built-ins. Tests use Node's built-in runner (`node --test`). This was a deliberate choice:
every new package is supply-chain surface, and nothing in the MVP required one.

---

## Stage 1 — Project setup

**Inspection first.** The directory was *not* empty: it contained a working Next.js 16.2.6 +
TypeScript + Tailwind 4 + Drizzle + PostgreSQL starter (`src/app/{page,layout,globals.css}`,
`src/app/api/health/route.ts`, `src/db/{index,schema}.ts`, configs, `.env`). No `.git`, no
`node_modules` issues, no partial application code. Nothing was overwritten or deleted; work
continued from that state and the starter's `src/` layout, `@/*` alias and health endpoint were
kept.

**Files changed:** `.gitignore` (new), `.env.example` (new), `tsconfig.json` (target
`ES2017` → `ES2022`, `allowImportingTsExtensions`).

**Commands run / results:**
| Command | Result |
| --- | --- |
| `psql … -c "select version()"` | PostgreSQL 15.19 reachable |
| `npm run build` (baseline, before changes) | passed — 3 routes |
| `npm exec tsc -- --noEmit` | passed, 0 errors |
| `npm run lint` | passed, 0 errors 0 warnings |
| `npx next typegen` | passed |

**Note on the environment:** the sandbox runs Node v22.23.2, not the v24.18.0 on the target
machine. Both support `node --test` with TypeScript type stripping, so the test commands work on
either. The `ES2022` bump was required because BigInt literals (used for IPv6 classification)
are not available below ES2020.

**Limitations:** none introduced. `.env` (the local connection string) is git-ignored; only
placeholder values live in `.env.example`.

---

## Stage 2 — Supabase foundation → documented deviation

**What was found:** the environment provides `DATABASE_URL` for a local PostgreSQL server. There
is **no Supabase project, no URL, no anon/publishable key and no service-role key**, and creating
one would require an external account and credentials that do not exist here.

**Decision (documented, not silent):** keep the fixed stack's *shape* — Postgres + Drizzle +
server-only privileged access — and implement the auth guarantees that Supabase Auth would have
provided, using `node:crypto`. `supabase/schema.sql` carries the identical schema plus RLS
policies written against `auth.uid()`, so moving the database to Supabase Postgres is a
connection-string change, and swapping `src/lib/auth/` for `@supabase/ssr` is contained.

**Key distinction preserved:** public/browser-safe values (`NEXT_PUBLIC_SUPABASE_URL`,
`NEXT_PUBLIC_SUPABASE_ANON_KEY`) are separated from privileged server-only credentials
(`SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_DB_PASSWORD`) in `.env.example`, with an explicit warning
that privileged values must never be `NEXT_PUBLIC_*` and never reach client code. No real secret
is written to any file, log or document.

---

## Stage 3 — Authentication

**Files added:** `src/lib/auth/password.ts`, `src/lib/auth/session.ts`, `src/lib/http.ts`,
`src/app/api/auth/{signup,login,logout}/route.ts`, `src/components/auth-form.tsx`,
`src/components/sign-out-button.tsx`, `src/app/{login,signup}/page.tsx`.

**Controls:** scrypt hashing (N=16384/r=8/p=1, 64-byte key, unique salt) verified with
`timingSafeEqual`; opaque 256-bit session tokens stored only as SHA-256 digests; HttpOnly +
SameSite=Lax cookies with Secure derived from `x-forwarded-proto`; generic login failure message
with dummy-hash timing equalisation; explicit same-origin check on all mutations; 16 KiB body
cap; `safeRedirectPath()` against open redirects; server-side validation authoritative over UI
validation; expired/revoked sessions clear their cookie.

**Verification (observed):** unit tests for hashing, salting, malformed-hash fail-closed, token
entropy/uniqueness, email normalisation and 12 open-redirect payloads; end-to-end: signup 201 +
cookie, weak password 400, wrong password 401 with the generic message, unknown email identical
401, cross-origin POST 403, logout then 401, and `?next=https://evil.example` / `?next=//evil.example`
neutralised on the login page.

**Limitations:** no password reset, no email verification, no MFA, no per-IP login throttling,
and signup discloses that an address is already registered (deliberate UX trade-off, documented
in `docs/SECURITY.md` §7.6–7.7).

---

## Stage 4 — Schema and Row Level Security

**Files:** `src/db/schema.ts` (3 tables), `supabase/schema.sql` (schema + RLS + policies),
`tests/rls-isolation.sql` (executable proof).

**Tables:** `users`, `sessions`, `scan_reports` — only what the MVP needs. No separate `profiles`
table, because no profile fields exist yet; adding one without a requirement would be scope.
Constraints and indexes: unique email, unique session token hash, indexes on
`(user_id, started_at)` for history and quota, `CHECK` constraints on status/duration/URL length,
cascade deletes from `users`.

**RLS:** enabled on all three tables with nine policies (SELECT/INSERT/UPDATE on `users` and
`sessions`; SELECT/INSERT/DELETE on `scan_reports`, with **no UPDATE policy** so stored evidence
is immutable).

**Verification (observed):** `psql -f supabase/schema.sql` then `psql -v ON_ERROR_STOP=1 -f
tests/rls-isolation.sql` → `NOTICE: RLS isolation verified: cross-user SELECT, UPDATE, DELETE and
ownership-claim INSERT were all denied.` Two throwaway users were created; as a non-owner
`NOBYPASSRLS` role impersonating user A, user B's report was invisible, undeletable and
unmodifiable, an INSERT claiming B's id was refused, and `pg_policies` confirmed all nine
policies. End-to-end: user B reading/deleting A's report returns 404, A's report survives, B's
history is empty, and a forged `userId` in the request body does not change ownership.

**Limitation stated honestly:** RLS does not constrain the *table owner*, and the app connects
with the privileged role, so the SQL ownership predicates in the route handlers are the operative
control for server queries. `FORCE ROW LEVEL SECURITY` was deliberately **not** set — the owner
connection has no JWT claim and would then see zero rows.

---

## Stage 5 — Scanner threat model and SSRF controls

**Files:** `src/lib/scanner/target-guard.ts`, `src/lib/scanner/http-client.ts`,
`src/lib/rate-limit.ts`, `tests/target-guard.test.ts`.

Implemented: scheme allowlist; default-ports-only (no port scanning); credential, control-character
and length rejection; mandatory scheme; internal-name deny list; IPv4 and IPv6 range
classification including cloud metadata; embedded-IPv4 extraction for mapped/NAT64/6to4/Teredo;
obfuscated-IPv4 and zone-id rejection; fail-closed on unknown formats; single DNS resolution with
**every** address validated; socket pinning via a `lookup` override; post-connect
`remoteAddress` re-verification; manual redirect following with full re-validation per hop;
inactivity/deadline/budget timeouts; body discarded at a byte cap; process-wide semaphore with
bounded, fail-closed queueing; durable per-account quota plus in-process concurrency limits;
`setHost: false` so the Host header is never the pinned IP; fixed request header allowlist.

**Verification (observed):** 44 policy assertions in `tests/target-guard.test.ts`, including a
test that starts a real HTTP server on `127.0.0.1` and asserts it **never receives a request**,
and live-DNS tests proving `example.com` pins to public addresses while `localtest.me` (which
answers `127.0.0.1`) is refused at the resolution layer. End-to-end: 12 hostile targets
(`169.254.169.254`, `127.0.0.1:5432`, `localhost:3000`, `file:`, `gopher:`, port 8443,
embedded credentials, `2130706433`, `[::1]`, `metadata.google.internal`, `printer.local`,
scheme-less host) all refused with the correct code and stored with an **empty transcript**
(zero requests sent). Rate limit produced 429 with `Retry-After`.

**Two real bugs were found by these tests and fixed:**
1. `looksLikeObfuscatedIpv4()` matched ordinary hostnames such as `example.com` (it treated any
   host with fewer than four labels as obfuscated) — this would have rejected every normal scan.
2. `::ffff:0:0/96` was missing from the blocked IPv6 ranges, so `http://[::ffff:127.0.0.1]/`
   was classified as an allowed global unicast address.

**Limitations:** per-instance concurrency caps (§7.5 of SECURITY.md); DNS answers are validated
but the resolver itself is trusted; a resolver returning public addresses that hairpin into
internal infrastructure is outside this control.

---

## Stage 6 — First real scanner feature

**Files:** `src/lib/scanner/analyze.ts` (pure analysis, 14 checks), `src/lib/scanner/run-scan.ts`
(orchestration + redaction + persistence), `src/app/api/scans/route.ts`,
`src/app/api/scans/[id]/route.ts`, `tests/analyze.test.ts`.

Each finding records: what was checked, the raw observed values as evidence, a status from
`pass | fail | warn | info | not_applicable | inconclusive`, a severity, remediation when
actionable, and a mandatory limitation string. A `scope-of-assessment` finding is always present.

**Honest-reporting rules that are enforced in code:** no response at all → `status='failed'` and
only two findings (the failure notice and the scope notice); an error-page response →
`inconclusive` with an explicit warning that findings describe the error page only; missing
cookies → `not_applicable` with text stating this is *not* evidence the site's cookies are safe;
no TLS handshake → `inconclusive`, except when the handshake failed for a certificate reason,
which is reported as a critical `fail` with the TLS error code as evidence.

**A third real bug was found by live verification and fixed:** when the user submitted an
`https://` URL, `httpsChain` was left empty (the primary chain was not reused as the HTTPS
evidence), so `https-availability` reported `fail` for `example.com` while `tls-certificate`
reported `pass`. Probes are now wired so the requested scheme's chain is always the evidence for
that scheme, and a regression guard was added to the end-to-end test.

**Verification (observed):** 25 analysis unit tests across six synthetic-but-realistic scenarios;
live scan of `https://example.com` → `outcome=completed`, 14 findings, and the stored statuses
match reality (HSTS/CSP/nosniff/Referrer-Policy/framing absent on `example.com` → `fail`;
TLS 1.3 + valid certificate → `pass`; no cookies → `not_applicable`; `http://example.com` serves
content without upgrading → `http-to-https-redirect` `fail`, which is accurate for that host).

---

## Stage 7 — Dashboard and UI

**Files:** `src/app/globals.css` (design tokens), `src/app/layout.tsx`, `src/app/page.tsx`,
`src/app/methodology/page.tsx`, `src/app/dashboard/page.tsx`,
`src/app/dashboard/scans/[id]/page.tsx`, `src/components/{site-header,ui,finding-card,scan-form,scan-actions}.tsx/ts`,
`next.config.ts` (security headers).

Graphite/dark-neutral surfaces with one restrained cyan accent. Responsive (table on ≥md, card
list below), accessible: skip link, semantic landmarks, `<label for>` on every field,
`aria-invalid`/`aria-describedby` for errors, `role="alert"`/`aria-live` for scan progress and
failures, native `<details>` for evidence disclosure (keyboard-operable without JS), visible
`:focus-visible` outlines, `prefers-reduced-motion` respected, `sr-only` table caption.
Empty, loading, success and error states are all implemented.

No charts, no counters, no testimonials, no logos, no "live activity" — nothing fabricated
anywhere in the UI. The landing page states the limitations next to the call to action.

**Verification (observed):** all pages fetched from the running production server and asserted to
contain their real content (19 render checks), including the report page rendering evidence,
limitations, the raw transcript and the "not a penetration test" notice; an unknown report id
renders the 404 page.

**Limitation:** SiteSentra's own CSP must allow `'unsafe-inline'`/`'unsafe-eval'` for scripts
until per-request nonces are added (SECURITY.md §7.1).

---

## Stage 8 — Security review and testing

| Check | Command | Result |
| --- | --- | --- |
| Route types | `npx next typegen` | ✓ generated |
| TypeScript | `npm exec tsc -- --noEmit --pretty false` | ✓ 0 errors |
| ESLint | `npm run lint` | ✓ 0 errors, 0 warnings |
| Production build | `npm run build` | ✓ 13 routes |
| Unit tests | `node --test tests/*.test.ts` | ✓ 88 passed, 0 failed, 0 skipped |
| RLS isolation | `psql -f tests/rls-isolation.sql` | ✓ verified (NOTICE printed) |
| End-to-end security | `node scripts/smoke.mjs` | ✓ 68 passed, 0 failed |
| Rendered HTML | one-off fetch assertions | ✓ 19 passed |
| Env handling | manual review | ✓ no secret in any committed file |
| Dependency review | `package.json` diff | ✓ zero added dependencies |

Unresolved items are listed in `docs/SECURITY.md` §7 — none of them is a broken boundary, but
items 1 (CSP nonces) and 7 (no login throttling/reset/MFA) are the ones to address before
serving real traffic.

---

## Stage 9 — GitHub and Vercel: **NOT PERFORMED (awaiting "ship it")**

No repository was initialised, no remote added, nothing pushed, nothing deployed. That stage
requires your explicit authorisation. When you say "ship it", the sequence is:

```powershell
git status                       # review what would be committed
git init ; git add -A
git status                       # confirm .env / .env.local are NOT listed
git commit -m "SiteSentra MVP: auth, SSRF-guarded scanner, RLS, dashboard"
git branch -M main
git remote add origin <your-github-repo-url>
git push -u origin main          # only with your authorisation
```

Then in Vercel: import the repo, set `DATABASE_URL` separately for Production and Preview
(point them at **different** databases), leave every privileged value without the
`NEXT_PUBLIC_` prefix, deploy, and re-run `node scripts/smoke.mjs` against the production URL.
A green deployment is not a security check — the smoke test is.

---

## Stage 10 — Real-user readiness: outstanding

Done: data minimisation, evidence redaction, abuse limits, published scope/limitations,
acceptable-use text, security headers, reproducible schema.

Outstanding before calling this production-ready: privacy policy and terms of use as real legal
pages; a password-reset and email-verification flow; login throttling/lockout; CSP nonces; backup
and restore rehearsal; a decision on report retention (currently indefinite); quota review
against the hosting plan's function-duration and egress limits; an incident-response runbook;
and a load test at expected concurrency. None of these are implemented, and none should be
described as done.

Expo/React Native was **not** started — the web MVP is the current scope, and mobile needs your
approval plus a decision about reusing the same session model.


---

## Review update — origin policy hardening

**Files changed:** `src/lib/auth/origin-policy.ts` (new), `src/lib/auth/session.ts`, `tests/origin-policy.test.ts` (new), `package.json`, `README.md`.

**Finding fixed:** the previous mutation-origin guard accepted `Sec-Fetch-Site: same-site` and compared only `.host`, which could trust a sibling subdomain and did not compare the scheme. The policy now compares the complete origin (`scheme + host + port`), treats an explicit malformed/mismatched Origin as a rejection, uses Referer only when Origin is absent, and accepts only exact `same-origin` Fetch Metadata as the final browser-header fallback. The policy was extracted into a framework-independent module for direct testing.

**Verification:** `node --experimental-strip-types --test tests/origin-policy.test.ts tests/analyze.test.ts tests/password.test.ts` passed **43 tests**. The broader target-guard test run reached 86 passes, one failure and one skip; the failure was the live-DNS test for `localtest.me`, because DNS resolution timed out in this environment (expected `ip-blocked`, received `dns-resolution-failed`). The public DNS test was skipped for the same environmental limitation. Dependency installation timed out, so a full Next.js typecheck/lint/production build could not be verified in this review environment.

---

## Stage 11 — Security hardening pass (auth throttling, strict origin, dependency CVEs)

**Baseline established first (nothing changed before it was measured):**

| Command | Result |
| --- | --- |
| `npm run typecheck` | passed, 0 errors |
| `npm run lint` | passed, 0 errors, 0 warnings |
| `node --test tests/{target-guard,analyze,password,origin-policy}.test.ts` | 95 pass, 0 fail, 1 skipped |
| `npm run build` | failed — `Error: DATABASE_URL is required` (environmental: no Postgres reachable, `ECONNREFUSED` on 127.0.0.1:5432) |
| `npm audit --omit=dev` | 3 vulnerabilities (2 high, 1 critical) — `next@16.2.6` in the vulnerable range |

The build failure and the one skipped test are both **environmental**, not application defects:
there is no reachable PostgreSQL server in this sandbox and DNS resolution for `example.com`
times out. No `.env`/`.env.local` exists.

**Files changed in this stage**

| File | Why |
| --- | --- |
| `src/lib/auth/attempt-limit.ts` (new) | Login/signup throttling. In-process sliding window keyed by salted SHA-256 digests of the account AND the client address. No new dependency. |
| `src/app/api/auth/login/route.ts` | Consume a login attempt before scrypt/DB; 429 + `Retry-After`; clear the account bucket on success. |
| `src/app/api/auth/signup/route.ts` | Consume a signup attempt before scrypt/DB; 429 + `Retry-After`. |
| `src/lib/auth/origin-policy.ts` | Split the policy into a permissive variant (unauthenticated endpoints) and `isTrustedMutationRequest` (cookie-authenticated mutations) which **fails closed** when no origin evidence is present. |
| `src/lib/auth/session.ts` | Re-export the strict variant. |
| `src/lib/http.ts` | Add `trustedOrigin()` helper; keep `originAllowed()` for login/signup. |
| `src/app/api/scans/route.ts` | POST now uses the strict origin check (cookie-authenticated). |
| `src/app/api/scans/[id]/route.ts` | DELETE now uses the strict origin check. |
| `src/app/api/auth/logout/route.ts` | Uses the strict origin check (revokes a session). |
| `scripts/smoke.mjs` | `call()` now sends a same-origin `Origin` on non-GET requests, matching what a browser does. |
| `tests/attempt-limit.test.ts` (new) | Deterministic limiter tests (injected clock) + key derivation + address bucketing. |
| `tests/tenant-isolation.test.ts` (new) | Cross-user isolation against a real DB; **skips cleanly** when `DATABASE_URL` is absent. |
| `tests/origin-policy.test.ts` | Added the strict-variant suite (sibling subdomain, scheme/port mismatch, malicious origin with lying Fetch Metadata, fail-closed on no headers). |
| `next.config.ts` / `package.json` / `package-lock.json` | `next` 16.2.6 → 16.4.2 and `postcss` → 8.5.31 to clear confirmed advisories. |
| `.env.example`, `README.md`, `docs/SECURITY.md` | Document the new variables and the corrected limitation text. |

**Security fixes completed**

1. **Auth throttling added.** Previously there was *no* limit on login or signup — unlimited
   credential stuffing and bulk account creation. Now: 10 logins / 20 signups per 15-minute window,
   checked against both a per-account and a per-address bucket. Keys are salted SHA-256 digests, so
   the in-memory map cannot be reversed to an email or IP. A successful login clears the account
   bucket. Documented limitation: the limiter is per-process (multi-instance → limit × instances).
2. **Strict origin policy for cookie-authenticated mutations.** The previous policy returned `true`
   when `Origin`, `Referer` and `Sec-Fetch-Site` were all absent. That path is now refused for
   `/api/scans` (POST), `/api/scans/[id]` (DELETE) and `/api/auth/logout`. Login/signup keep the
   permissive behaviour because they carry no ambient credential and are now throttled.
3. **Dependency CVEs cleared.** `next@16.2.6` fell inside the advisory range that includes
   unauthenticated RCE and SSRF in the Image Optimization API. Upgraded to `next@16.4.2`
   (current `latest` in the same major). `npm audit --omit=dev` now reports **0 vulnerabilities**.

**Verification of this stage**

- `npm run typecheck` — passed, 0 errors.
- `npm run lint` — passed, 0 errors, 0 warnings.
- `node --test` (all six unit files) — **119 pass, 0 fail, 1 skipped** (DNS-dependent; the new
  tenant-isolation suite also skips without a database).
- `npm run build` with `DATABASE_URL` set — **compiled successfully** on Next.js 16.4.2, all 13
  routes generated. The earlier failure was solely the missing env var.
- `npm audit --omit=dev` — **0 vulnerabilities**.

**Not verified in this environment (needs a reachable database)**

- `tests/tenant-isolation.test.ts` (skipped) and `tests/rls-isolation.sql` — require PostgreSQL.
- `scripts/smoke.mjs` — requires a running server and a database.
- Live DNS test for `example.com` — DNS unavailable here.

**Not changed, and why:** the CSP `script-src 'unsafe-inline' 'unsafe-eval'` limitation remains.
Removing it needs per-request nonces in a middleware layer; doing that halfway would either break
the app or give a false sense of a strict policy. It stays documented as the top remaining
hardening item.
