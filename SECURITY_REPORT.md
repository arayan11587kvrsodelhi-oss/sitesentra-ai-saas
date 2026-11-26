
# SiteSentra Security Hardening Report

## Report metadata

- **Original audit date:** November 6, 2026
- **Verification update:** November 26, 2026
- **Application:** SiteSentra
- **Framework:** Next.js 16.4.2
- **Database:** Neon PostgreSQL
- **ORM:** Drizzle ORM 0.45.2
- **Original audit commit:** `6e6e73e`
- **Integration test branch:** `sitesentra-integration-tests`
- **Integration endpoint:** `ep-red-dawn-aon99mux`

> This report combines historical source-review findings with a separately dated
> integration-test verification. It is not an independent penetration test or
> a certification of production security.

---

## 1. Executive summary

SiteSentra is a Next.js application that performs unauthenticated HTTP(S)
configuration checks against user-submitted URLs.

The application uses:

- Cookie-based authentication.
- Scrypt password hashing.
- Drizzle ORM with Neon PostgreSQL.
- A custom HTTP scanner with SSRF protections.
- Application-level ownership checks for user data.
- Request validation, rate limits, and security response headers.

### Historical audit assessment

The November 6 audit documented the following work:

| Area | Historical finding |
|---|---|
| Session cookie Secure flag | Fixed |
| Authentication redirect loop | Fixed |
| CSRF and Origin validation | Hardened |
| Scanner capacity information leak | Fixed |
| Stale proxy documentation | Corrected |
| Password hashing and session lifecycle | Reviewed |
| Database ownership predicates | Reviewed |
| SSRF target validation | Reviewed |
| CSP nonce implementation | Not implemented |
| Multi-instance rate limiting | Known limitation |

### November 26 verification

The following checks were subsequently executed:

| Check | Result |
|---|---:|
| TypeScript typecheck | Passed |
| ESLint | Passed |
| Integration tests | 36 passed |
| Integration test failures | 0 |
| Integration tests skipped | 0 |
| `git diff --check` | Passed |
| `git diff --cached --check` | Passed |

The integration suite ran against the isolated Neon test branch. The runner
checked the expected database identity and verified that the application
database module and test pool shared the same database.

Test-generated records were cleaned up after execution.

These results demonstrate that the tested code paths passed the executed
checks. They do not establish that every production configuration or
deployment environment is secure.

---

## 2. Authentication and session security

### Password hashing

The historical source review documented:

- Algorithm: scrypt.
- Parameters: N=16384, r=8, p=1.
- Derived key length: 64 bytes.
- Salt: 16 random bytes per password.
- Constant-time comparison using `timingSafeEqual`.

### Session management

The reviewed session implementation uses:

- 256-bit random session tokens.
- SHA-256 token digests stored in the database.
- HttpOnly cookies.
- SameSite=Lax.
- Secure cookies in production.
- Session expiry and revocation tracking.
- Cookie deletion during logout.
- Opportunistic cleanup of expired sessions.

The cookie Secure attribute is determined by:

```typescript
process.env.NODE_ENV === "production"
```

This avoids relying on request-supplied forwarding headers to decide whether
the session cookie should use the Secure attribute.

### Authentication throttling

The environment template documents these defaults:

| Setting | Default |
|---|---:|
| Login attempts | 10 per 15 minutes |
| Signup attempts | 20 per 15 minutes |
| Session lifetime | 604800 seconds |

The in-process authentication limiters are not globally shared across
multiple application instances.

---

## 3. CSRF and Origin validation

The historical audit reviewed Origin and Referer validation, including:

- Host and request URL origin consistency.
- Forwarded-host handling.
- Scheme and port mismatches.
- Origin and Referer disagreement.
- Empty or malformed Origin values.
- Case-insensitive schemes.
- Trailing-dot hostname behavior.

The audit documented additional regression tests for these cases.

Origin validation should continue to be tested whenever proxy, deployment,
or request-routing behavior changes.

---

## 4. Scanner security and SSRF protection

The scanner accepts user-submitted HTTP(S) targets. This creates a risk of
server-side request forgery if internal or restricted destinations are
reachable.

The historical audit documented protections covering:

1. IPv4 and IPv6 private, loopback, and link-local ranges.
2. Cloud metadata destinations.
3. Multicast and reserved IP ranges.
4. Obfuscated IP address representations.
5. Internal hostnames and single-label hostnames.
6. DNS resolution validation and address pinning.
7. Redirect revalidation.
8. Restricted destination ports.
9. Response size and request timeouts.

The historical SSRF suite reported 52 passing tests and one DNS-dependent
test skipped in its test environment.

The November 26 integration suite also passed its SSRF-related integration
checks. This does not replace independent testing against real-world DNS
rebinding and network edge cases.

---

## 5. Scanner error handling and information disclosure

The historical audit reviewed:

- Generic user-facing error messages.
- Server-side error logging.
- Redaction of Set-Cookie values before storage.
- Sanitization of scanner and TLS error responses.
- Scanner capacity error messages.

Sensitive cookie values, authentication tokens, and database credentials
must not be exposed in API responses, logs, or stored scan evidence.

---

## 6. Database security and ownership isolation

SiteSentra uses Neon PostgreSQL with Drizzle ORM.

The historical audit reviewed application-level ownership predicates,
including user-scoped queries for scan reports and dashboard data.

Examples of the intended access pattern:

```sql
SELECT *
FROM scan_reports
WHERE id = $1
  AND user_id = $2;
```

The authenticated user identity must be derived from the validated server-side
session, not from an untrusted client-supplied user ID.

### Row-level security

The historical audit found RLS policies defined in `supabase/schema.sql`.
Those policies were not established as the primary isolation boundary for
the application's privileged database connection.

PostgreSQL table owners generally bypass RLS unless row-level security is
forced. Therefore, application-level ownership predicates remain critical.

RLS policy definitions should not be described as proof that the production
application connection enforces RLS.

---

## 7. Rate limiting and resource controls

The documented defaults include:

| Control | Default |
|---|---:|
| Scan quota | 12 per user per 60 minutes |
| Scanner concurrency | 3 per process |
| Scanner queue timeout | 10 seconds |
| Connection timeout | 5 seconds |
| Total request timeout | 15 seconds |
| Maximum response body | 65536 bytes |

### Known limitation

In-memory rate limiters and concurrency controls are process-local.

With multiple application instances, the effective aggregate limit can
exceed the configured per-process limit.

A shared coordination mechanism, such as Redis or a suitable PostgreSQL
strategy, would be needed for strict cross-instance enforcement.

---

## 8. Content Security Policy

The historical audit identified `unsafe-inline` and `unsafe-eval` in the
script policy as unresolved concerns.

A nonce-based Content Security Policy was not implemented in the original
audit.

This remains a security-hardening item requiring careful validation of
Next.js App Router streaming, hydration, and script loading behavior.

Do not claim that the application has a strict nonce-based CSP unless that
implementation has been completed and independently verified.

---

## 9. Integration test verification — November 26, 2026

The integration suite was executed against the disposable Neon branch:

- Branch: `sitesentra-integration-tests`
- Endpoint: `ep-red-dawn-aon99mux`
- Database: `sitesentra`

### Test results

| Test area | Result |
|---|---|
| Database identity checks | Passed |
| Application/test-pool database consistency | Passed |
| Direct SQL session and report isolation | Passed |
| SSRF protection | Passed |
| Application session flows | Passed |
| Concurrent request-context isolation | Passed |
| Logout endpoint | Passed |
| Health and scan route handlers | Passed |
| Scan ownership | Passed |
| Authentication endpoints | Passed |
| Rate limiting | Passed |

**Total: 36 passed, 0 failed, 0 skipped.**

The runner verified that the application database module and test pool
shared the same database using a bidirectional sentinel check.

Test cleanup reported:

- Sessions removed: 17
- Scan reports removed: 4
- Users removed: 11

The runner also checked the configured endpoint ID, database name, and
branch marker. The branch marker is operator-confirmed and should not be
represented as independent verification of the provider-side branch name.

### Reproduction

Configure the integration environment variables in PowerShell, then run:

```powershell
npm run typecheck
npm run lint
npm run test:integration
git diff --check
git diff --cached --check
```

The integration runner reads `DATABASE_URL_INTEGRATION` and must not fall
back to the production `DATABASE_URL`.

Use only a disposable test database. Never point this suite at production.

---

## 10. Outstanding risks

| Risk | Status | Recommended action |
|---|---|---|
| CSP `unsafe-inline` / `unsafe-eval` | Unresolved in historical audit | Evaluate nonce-based CSP |
| In-memory rate limiting | Documented limitation | Use shared storage for multi-instance enforcement |
| RLS with privileged database role | Application predicates are primary control | Consider a restricted application role |
| Integration tests in CI | Not established by this verification | Configure isolated CI test database |
| Production deployment verification | Not established by this verification | Verify deployed headers, cookies, and API behavior |
| DNS-dependent SSRF test | Historically skipped in one environment | Run in a network-enabled test environment |

---

## 11. Deployment checklist

Before production deployment:

- [ ] Set `NODE_ENV=production`.
- [ ] Configure `DATABASE_URL` for the production Neon branch.
- [ ] Keep database credentials and privileged keys server-only.
- [ ] Confirm `.env.local` and other secret-bearing environment files are ignored by Git.
- [ ] Confirm session cookies use Secure, HttpOnly, and SameSite=Lax.
- [ ] Review authentication and scanner rate-limit settings.
- [ ] Verify scanner timeout and response-size limits.
- [ ] Review CSP and other security response headers on the deployed site.
- [ ] Run integration tests only against an isolated disposable database.
- [ ] Monitor authentication failures, scan errors, and rate-limit rejections.
- [ ] Verify production behavior independently after deployment.

---

## 12. Final classification

| Security area | Classification |
|---|---|
| Cookie Secure flag | Fixed and tested in historical audit |
| Authentication redirect loop | Fixed and tested in historical audit |
| CSRF and Origin validation | Hardened in historical audit |
| Scanner capacity information leak | Fixed in historical audit |
| Password hashing | Reviewed in historical audit |
| Session lifecycle | Reviewed in historical audit |
| Database ownership predicates | Reviewed; integration checks passed |
| SSRF protections | Historical unit tests and current integration checks passed |
| Scanner error handling | Reviewed in historical audit |
| CSP nonce implementation | Not implemented in historical audit |
| Multi-instance rate limiting | Known limitation |
| Integration suite | 36 passed on November 26, 2026 |
| Production deployment security | Not established by these test results |

---

## Report limitations

This report records source-review findings and the specific test executions
listed above.

It does not claim:

- An independent penetration test.
- A third-party security certification.
- Verification of every production environment variable.
- Verification of all live deployment headers and cookie behavior.
- Strict global rate limiting across multiple instances.
- A completed nonce-based CSP implementation.

**Report prepared for:** SiteSentra project security documentation
**Original audit reference:** `6e6e73e`
**Latest integration verification:** November 26, 2026
