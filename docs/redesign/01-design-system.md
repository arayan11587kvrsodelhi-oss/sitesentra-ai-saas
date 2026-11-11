# SiteSentra — Redesign Phase 1–2: audit, design system, wireframes

## Phase 1 — Audit (what actually exists)

### Routes

| Route | Type | Auth | Notes |
| --- | --- | --- | --- |
| `/` | server component | public | Landing. Shows header/footer. |
| `/methodology` | server component | public | Explains checks, SSRF policy, limits, acceptable use. Real destination. |
| `/login`, `/signup` | server component + client form | public | `safeRedirectPath` honoured; signed-in users redirected. |
| `/dashboard` | server component | **required** | Stats, scan form, table of last 50 scans (mobile list shows only 5). |
| `/dashboard/scans/[id]` | server component | **required** | Full report, findings, transcript, delete. |
| `/api/scans` (POST/GET) | route handler | required | Real scan engine; SSRF guard; quota; one-at-a-time. |
| `/api/scans/[id]` (DELETE) | route handler | required | Ownership enforced in SQL. |
| `/api/auth/*`, `/api/health` | route handler | — | Untouched. |

There is **no** `/dashboard/history`, **no** filters, **no** pagination, **no** settings page, and **no**
public unauthenticated scan. So: no new nav link will be invented except a real
Scan History route (see below), which is a genuine new page that reuses the
*existing* database query, unchanged.

### Real data available per scan

`scan_reports`: `id, inputUrl, normalizedUrl, targetHost, resolvedAddresses, status
(completed|inconclusive|failed), failureCode, failureMessage, report (jsonb), summary
(jsonb non-typed `Record<string, number>`), durationMs, startedAt, finishedAt`.

`report` (v1, `StoredReport`): `{ version, outcome, assessedUrl, findings[], summary,
failure, meta { inputUrl, requestedScheme, userAgent, scannedAt,
durationMs, validatedAddresses, transcript[] } }`.

`summary` in the DB is the real `FindingSummary`: `total, pass, fail, warn, info,
not_applicable, inconclusive, bySeverity {critical,high,medium,low,info},
highestActionableSeverity`.

Finding: `id, title, category, status, severity, whatWasChecked, evidence[{label,value}],
recommendation, limitations`.

Transcript hop: `probe (requested|https|http), url, scheme, statusCode, responseTimeMs,
headers, cookies, tls, error`.

**There is no score, no percentage, no separate CRITICAL/HIGH/LOW/MEDIUM finding
status.** The five *severity* levels exist and the four *statuses* (fail/warn/
pass/inconclusive) exist, so severity distribution is legitimate; a “security
score” is not, and is not shown.

### Defects found in the existing UI (all pre-existing)

1. **Tailwind never compiled.** `globals.css` uses `@tailwind base/components/
   utilities` (v3 directives) with Tailwind v4, and no `@theme` / `--color-*`
   tokens exist. Only the hand-written utility classes (`.bg-crimson`, `.surface`,
   `.text-secondary`…) resolve. Every real Tailwind class in the components
   (`bg-graphite`, `rounded-lg`, `border-border`, `text-mist-200`,
   `focus:ring-signal-400`…) produces no CSS. `border-border` is false in the
   shipped stylesheet — verified against the served CSS chunk.
2. **The application renders in light mode for light-preference users.** A
   `@media (prefers-color-scheme: light)` block flips `--obsidian` to `#F8FAFC`
   while `--text-primary` stays near-white. The whole app becomes unreadable.
   This is what the production screenshot shows.
3. **Horizontal overflow on every signed-in page** (dashboard, report, login,
   signup): `scrollWidth` 1465 vs 1440 desktop and 415 vs 390 mobile — caused by
   a `header`/`footer { background: graphite; border-bottom }` rule plus
   `button:hover { transform: translateY(-1px) }` on every button.
4. **Report summary numbers are invisible**: `className="… font-mono {item.tone}"`
   — literal braces, so `text-critical` etc. never apply.
5. **Report page still references colours that no longer exist**: `text-cyan`,
   `bg-cyan/5`, `text-crimson-bright`, `hover:text-crimson-primary` (auth form).
   These classes simply do nothing.
6. Landing headers say “Security Configuration Checks”/“Recent Scan History” in
   crimson; the dashboard mobile list silently shows 5 of 50 scans with a
   “View all N reports” link that points at the same page.
7. Conversations use ✕ / ▸ text glyphs and emoji-ish arrows rather than icons.
8. Buttons inside forms are styled by the global `button` rule (crimson,
   translated on hover, no size) rather than by a component.

### What is preserved (checklist)

- [x] `src/lib/**` (auth, session, password, scrypt, origin policy, rate limit,
      scanner: target-guard, http-client, analyze, run-scan) — **no edits**.
- [x] `src/app/api/**` — **no edits**.
- [x] `src/db/**`, `drizzle/**`, `drizzle.config.*` — **no edits**.
- [x] `src/proxy.ts`, `next.config.ts` — **no edits** (CSP untouched).
- [x] Request/response contracts (`POST /api/scans {url}`, `DELETE /api/scans/:id`,
      `POST /api/auth/login|signup|logout`) — **no edits**.
- [x] HttpOnly cookie, SameSite, Secure derivation, scrypt — **untouched**.
- [x] Every dashboard/report query stays a server component query filtered by the
      session user's id.
- UI edits only: `src/app/**` pages/layouts, `src/components/**`, `globals.css`.

---

## Design system

### Concept — “Observation ledger”
A SiteSentra report is a *record of what a machine observed*. The interface therefore
reads like the instrument, not like a marketing site:

- **Hairline structure over cards.** Panels are separated by 1px `--line` borders
  and section rules, not floating rounded cards with shadows. Radius is 6px (4px
  for controls) — near-square, technical.
- **A left rail that behaves like an instrument panel**, with a workspace label,
  grouped nav, live quota meter and the account at the bottom.
- **Mono for anything a machine produced** (URLs, IDs, header values, counters,
  timestamps, TLS fields) and Inter for anything written for a human.
- **One accent.** Crimson appears on the primary action, the active nav item,
  focus rings, and the brand mark. Severity has its own scale; success is a
  restrained green; informational is a muted blue-grey.
- **Severity is a visual language of its own**, used consistently in the
  distribution bar, the finding spine, badges and history rows.

### Colour tokens (dark, single theme — light mode removed deliberately)

| Token | Value | Use |
| --- | --- | --- |
| `--bg-base` | `#0B0C0F` | page |
| `--bg-raised` | `#101114` | sidebar / header bands |
| `--bg-panel` | `#14151A` | panels, tables |
| `--bg-inset` | `#191B20` | wells, inputs, code blocks |
| `--bg-hover` | `#202229` | hover rows, active nav |
| `--line` | `#24262E` | hairline borders |
| `--line-strong` | `#34363E` | emphasised borders |
| `--fg` | `#F5F3F1` | primary text |
| `--fg-soft` | `#C9C8CB` | secondary text (labels) |
| `--fg-muted` | `#9A9AA2` | muted text (meets 4.5:1 on `--bg-panel`) |
| `--fg-faint` | `#737782` | only for non-essential decoration / disabled |
| `--crimson` | `#C51F3A` | brand / primary action |
| `--crimson-hover` | `#E43B50` | hover of primary action |
| `--crimson-deep` | `#8F142B` | pressed |
| semantic | critical `#EF4444` · high `#F97316` · medium `#F5A524` · low `#5B9DFF` · passed `#3EC08A` · info `#8A93A6` | severity only |

### Type scale (Inter + JetBrains Mono, `next/font` self-hosted → CSP `font-src 'self'`)

| Role | Size / line / weight | Family |
| --- | --- | --- |
| Display | 56/60 · 600 · -0.03em | sans |
| H1 | 32/40 · 600 | sans |
| H2 | 22/30 · 600 | sans |
| H3 / panel title | 15/22 · 600 | sans |
| Body | 14/22 | sans |
| Small | 13/20 | sans |
| Micro label | 11/16 · 500 · +0.08em · uppercase | mono |
| Data | 13/20 | mono |
| Data small | 12/18 | mono |

### Spacing — 4px rhythm (`--sp-1`…`--sp-16`), radii `--r-sm 4` / `--r 6` / `--r-md 8`.
### Elevation: a single soft ring (`0 0 0 1px line`) + `0 1px 0 rgba(255,255,255,.02)`
inset; dialogs get one real shadow. No crimson glow.

### Components (`src/components/ui`)

`Button` (primary / secondary / ghost / danger, sm/md/lg, `asChild`),
`Panel` + `PanelHeader`, `Badge` + `SeverityBadge` + `StatusBadge` + `OutcomeBadge`,
`Field`/`Label`/`Input`, `Stat`, `DistributionBar`, `DataWell`, `EmptyState`,
`InlineAlert`, `SectionRule`, `Kbd`, `Spinner`.

---

## Wireframes

### Landing — desktop (1440)

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ ▣ SiteSentra   Product  Methodology           Sign in   [ Start a scan ]     │ 68px, hairline
├──────────────────────────────┬───────────────────────────────────────────────┤
│  WEBSITE SECURITY ASSESSMENT │  ┌ scan result card ──────────────────────┐   │
│  See the security            │  │ TARGET  akasha.cv        ● COMPLETED   │   │
│  configuration a site        │  │ ────────────────────────────────────── │   │
│  actually serves.            │  │ SEVERITY   ■■   ■■   ■   □   □         │   │
│                              │  │            med  med  low                │   │
│  One unauthenticated request │  │ ────────────────────────────────────── │   │
│  … evidence … limitations.   │  │ Strict-Transport-Security   ● missing  │   │
│                              │  │ Content-Security-Policy     ● missing  │   │
│  [ https://example.com  Scan ]│  │ X-Content-Type-Options      ● missing  │   │
│  Read the methodology →      │  │ Referrer-Policy             ● missing  │   │
│                              │  │ Permissions-Policy          ◐ weak     │   │
│  Not a penetration test …    │  │ HTTPS · TLS 1.3             ✓ observed │   │
│                              │  │ 6 issues · 1 warning · 4 OK · 533 ms   │   │
│                              │  └────────────────────────────────────────┘   │
├──────────────────────────────┴───────────────────────────────────────────────┤
│ 01 URL submitted → 02 Transport observed → 03 Findings written → 04 Review    │
├──────────────────────────────┬───────────────────────────────────────────────┤
│ WHAT A SCAN OBSERVES         │  index list, two columns, numbered rows        │
├──────────────────────────────┴───────────────────────────────────────────────┤
│ Limits panel (left, wide) │ Safety panel (right) │ Methodology link           │
└──────────────────────────────────────────────────────────────────────────────┘
```

### Dashboard — desktop (1440)

```
┌────────────┬─────────────────────────────────────────────────────────────────┐
│ ▣ SiteSentra│ Security overview                        ● 12 checks left  [⟳] │
│            ├─────────────────────────────────────────────────────────────────┤
│ WORKSPACE  │  ┌ Run a new check ───────────────────────────────────────────┐ │
│ ▸ Overview │  │ https://  | example.com                        [ Run check ]│ │
│ ▸ Scan     │  │ One unauthenticated GET …     12 of 12 checks · 60 min     │ │
│   history  │  └────────────────────────────────────────────────────────────┘ │
│            │  ┌ Assessed targets 2 ┐┌ Actionable findings 7 ┐┌ Verified 15 ┐ │
│ SECURITY   │  └─────────────────────┘└───────────────────────┘└─────────────┘ │
│ ▸ Method.  │  ┌ Severity distribution ─────────────┐┌ Service state ────────┐│
│            │  │ ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓░░░░░  by severity ││ Completed · 2         ││
│ ────────── │  │ CRIT 0  HIGH 0  MED 4  LOW 3  INFO 6││ Failed · 0            ││
│ ● account  │  └────────────────────────────────────┘└───────────────────────┘│
│ email ▾    │  ┌ Recent reports ─────────────────────────────  View history →┐│
│            │  │ target | severity | issues | observed | duration | when | → ││
│ QUOTA ─────│  └────────────────────────────────────────────────────────────┘ │
│ 12/12      │                                                                 │
└────────────┴─────────────────────────────────────────────────────────────────┘
```

### Report — desktop (1440)

```
┌────────────┬────────────────────────────────────────────────────────────────┐
│ (same rail)│ ← Scan history                                                 │
│            │ akasha.cv                                 ● Completed  [Delete] │
│            │ https://akasha.cv · 08 Nov 2026 08:44 UTC · 533 ms             │
│            ├────────────────────────────────────────────────────────────────┤
│            │ ASSESSMENT  ┌────────┬──────────────────────────────────────┐  │
│            │             │ 6      │ Severity  ▮▮▮▮ MEDIUM 4 · LOW 3     │  │
│            │             │ issues │ Status    FAIL 6 · WARN 1 · PASS 4  │  │
│            │             │ 1 warn │ Verdict   Inconclusive → completed  │  │
│            │             │ 4 ok   │ Assessed  https://akasha.cv         │  │
│            │             └────────┴──────────────────────────────────────┘  │
│            │ FINDINGS (10)   [All] [Failures 6] [Warnings 1] [Passed 4]      │
│            │ ┌ ▍MEDIUM  Strict-Transport-Security                    ⌄ ┐     │
│            │ │  Affected header  ·  observed vs recommended  …        │     │
│            │ └────────────────────────────────────────────────────────┘     │
│            │ PASSED CHECKS — compact list, green tick spine                  │
│            │ REQUEST TRANSCRIPT — mono, collapsible hops, sticky table       │
│            │ METHODOLOGY & SCOPE — secondary                                 │
└────────────┴────────────────────────────────────────────────────────────────┘
```

### Mobile (390)

- Header: brand + `⋮` drawer button. Drawer: full-height sheet with the same
  grouped nav, quota meter, account + sign out.
- Dashboard: scan form stacks (input, then full-width button); stats become a
  2×2 hairline grid inside one panel; distribution becomes stacked rows;
  history becomes a list of rows, whole-row tap target ≥ 56px.
- Report: summary becomes a vertical stat block; filter chips scroll
  horizontally inside their own band (no page overflow); findings full width;
  evidence values wrap instead of scrolling.

## Component architecture

```
src/components/
  app-shell.tsx        (server) — sidebar + mobile drawer + topbar wrapper
  nav.tsx              (client) — active state, drawer open/close, sign-out
  brand.tsx            (shared) — mark + wordmark
  site-chrome.tsx      (server) — public header + footer
  marketing/hero-scan-panel.tsx (server, static markup) — honest example panel
  scan-form.tsx        (client, rewritten) — dashboard scan workspace
  scan-workspace.tsx   (client, new) — hero URL form → signup redirect for anon users
  history-table.tsx    (server) — desktop table + mobile rows
  severity.ts          (shared) — severity/status/outcome vocabulary + tone map
  finding-card.tsx     (server, rewritten) — evidence-first disclosure
  report/*.tsx         (server) — summary, distribution, transcript
  content.ts           (shared) — the marketing copy that already existed
```

Kept: `scan-actions.tsx` (delete), `sign-out-button.tsx` (logic; restyled via a
variant), `scan-status.ts` (re-exported from `severity.ts` to avoid breaking imports).
