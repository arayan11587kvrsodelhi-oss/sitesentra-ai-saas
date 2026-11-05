/**
 * SiteSentra — hardened outbound HTTP client used by the scanner.
 *
 * Everything that touches the network lives here, and everything here goes
 * through `target-guard.ts` first.
 *
 * Controls implemented:
 *  - GET only, no request body, a fixed header allowlist (users cannot inject
 *    headers, methods or payloads).
 *  - Connection pinned to a pre-validated IP via a `lookup` override, with the
 *    real `remoteAddress` re-checked after connect (defeats DNS rebinding and
 *    TOCTOU races).
 *  - `setHost: false` so the Host header is the hostname, never the pinned IP.
 *  - Redirects followed manually (max 5); every hop is re-parsed, re-resolved
 *    and re-validated.
 *  - Inactivity timeout, absolute deadline per chain, and an overall scan budget.
 *  - Response body is discarded and the socket is destroyed after a byte cap.
 *  - A process-wide semaphore caps concurrent outbound requests; waiting is
 *    bounded and fails closed.
 */
import http from "node:http";
import https from "node:https";
import type { Socket } from "node:net";
import type { PeerCertificate, TLSSocket } from "node:tls";

import {
  isCertificateError,
  type HeaderBag,
  type Observation,
  type ObservedHop,
  type TlsObservation,
} from "@/lib/scanner/analyze";
import {
  MAX_REDIRECTS,
  TargetRejectedError,
  isTargetRejected,
  parseTargetUrl,
  resolveAndPinTarget,
  assertRemoteAddressAllowed,
  validateRedirectLocation,
  type ParsedTarget,
  type PinnedTarget,
} from "@/lib/scanner/target-guard";

export type ScannerLimits = {
  /** Inactivity timeout for a single request. */
  connectTimeoutMs: number;
  /** Absolute budget for one redirect chain. */
  totalTimeoutMs: number;
  /** Absolute budget for the whole scan (all chains). */
  scanBudgetMs: number;
  maxResponseBytes: number;
  maxRedirects: number;
  maxConcurrent: number;
  queueTimeoutMs: number;
};

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function getScannerLimits(): ScannerLimits {
  return {
    connectTimeoutMs: intEnv("SCANNER_CONNECT_TIMEOUT_MS", 5000),
    totalTimeoutMs: intEnv("SCANNER_TOTAL_TIMEOUT_MS", 12000),
    scanBudgetMs: intEnv("SCANNER_SCAN_BUDGET_MS", 25000),
    maxResponseBytes: intEnv("SCANNER_MAX_RESPONSE_BYTES", 65536),
    maxRedirects: intEnv("SCANNER_MAX_REDIRECTS", MAX_REDIRECTS),
    maxConcurrent: intEnv("SCANNER_MAX_CONCURRENT_REQUESTS", 3),
    queueTimeoutMs: intEnv("SCANNER_QUEUE_TIMEOUT_MS", 10000),
  };
}

/** Identifies our scanner honestly, as robots/ops teams expect. */
export const SCANNER_USER_AGENT =
  "SiteSentra/1.0 (+website-security-configuration-checker; single unauthenticated GET)";

const FIXED_REQUEST_HEADERS: Record<string, string> = {
  "user-agent": SCANNER_USER_AGENT,
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "accept-language": "en",
  "cache-control": "no-cache",
  connection: "close",
};

// ---------------------------------------------------------------------------
// Concurrency control
// ---------------------------------------------------------------------------

type QueueEntry = { resolve: () => void; reject: (error: Error) => void };

/** Raised when the concurrency cap cannot grant a slot within the wait budget. */
export class ScannerCapacityError extends Error {
  readonly code = "scanner-at-capacity";
  constructor(message: string) {
    super(message);
    this.name = "ScannerCapacityError";
  }
}

class RequestSemaphore {
  private readonly max: number;
  private active = 0;
  private readonly queue: QueueEntry[] = [];

  constructor(max: number) {
    this.max = Math.max(1, max);
  }

  acquire(timeoutMs: number): Promise<() => void> {
    if (this.active < this.max) {
      this.active += 1;
      return Promise.resolve(() => this.release());
    }
    return new Promise<() => void>((resolve, reject) => {
      const entry: QueueEntry = {
        // Slot is transferred to this waiter, so `active` is not incremented
        // again here.
        resolve: () => resolve(() => this.release()),
        reject,
      };
      this.queue.push(entry);
      const timer = setTimeout(() => {
        const index = this.queue.indexOf(entry);
        if (index !== -1) this.queue.splice(index, 1);
        reject(new ScannerCapacityError("Scanner is at capacity; the request was not sent. Try again shortly."));
      }, timeoutMs);
      timer.unref?.();
    });
  }

  private release(): void {
    const next = this.queue.shift();
    if (next) {
      next.resolve();
      return;
    }
    this.active -= 1;
  }

  get inFlight(): number {
    return this.active;
  }
}

const globalForScanner = globalThis as typeof globalThis & {
  __siteSentraSemaphore?: RequestSemaphore;
};

function semaphore(limits: ScannerLimits): RequestSemaphore {
  if (!globalForScanner.__siteSentraSemaphore) {
    globalForScanner.__siteSentraSemaphore = new RequestSemaphore(limits.maxConcurrent);
  }
  return globalForScanner.__siteSentraSemaphore;
}

// ---------------------------------------------------------------------------
// TLS error classification
// ---------------------------------------------------------------------------



// ---------------------------------------------------------------------------
// One request
// ---------------------------------------------------------------------------

function headerBag(rawHeaders: http.IncomingHttpHeaders): HeaderBag {
  const bag: HeaderBag = {};
  for (const [key, value] of Object.entries(rawHeaders)) {
    if (value === undefined) continue;
    const name = key.toLowerCase();
    const values = Array.isArray(value) ? value : [value];
    bag[name] = [...(bag[name] ?? []), ...values.map((v) => String(v))];
  }
  return bag;
}

/** Certificate fields can be typed as string | string[]; normalise to a string. */
function commonName(entity: unknown): string | null {
  if (!entity || typeof entity !== "object") return null;
  const value = (entity as { CN?: unknown }).CN;
  if (typeof value === "string") return value;
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  return null;
}

function readTls(socket: Socket | null, hostname: string): TlsObservation | null {
  if (!socket) return null;
  const tlsSocket = socket as TLSSocket;
  if (typeof tlsSocket.getPeerCertificate !== "function") return null;
  let cert: PeerCertificate;
  try {
    cert = tlsSocket.getPeerCertificate();
  } catch {
    return null;
  }
  const validTo = cert.valid_to ? new Date(cert.valid_to) : null;
  const daysUntilExpiry = validTo && !Number.isNaN(validTo.getTime())
    ? Math.floor((validTo.getTime() - Date.now()) / 86400000)
    : null;
  const altNames = typeof cert.subjectaltname === "string"
    ? cert.subjectaltname.split(",").map((s) => s.trim().replace(/^DNS:/i, ""))
    : [];
  return {
    protocol: typeof tlsSocket.getProtocol === "function" ? tlsSocket.getProtocol() : null,
    cipher: typeof tlsSocket.getCipher === "function" ? (tlsSocket.getCipher()?.name ?? null) : null,
    authorized: tlsSocket.authorized === true,
    authorizationError: tlsSocket.authorizationError ? String(tlsSocket.authorizationError) : null,
    subjectCN: commonName(cert.subject),
    issuerCN: commonName(cert.issuer),
    validFrom: cert.valid_from ?? null,
    validTo: cert.valid_to ?? null,
    daysUntilExpiry,
    altNames: altNames.length > 0 ? altNames : hostname ? [hostname] : [],
  };
}

async function performRequest(
  pinned: PinnedTarget,
  limits: ScannerLimits,
  deadlineAt: number,
): Promise<ObservedHop> {
  const release = await semaphore(limits).acquire(limits.queueTimeoutMs);
  const startedAt = Date.now();
  const baseHop = {
    url: pinned.href,
    hostname: pinned.hostname,
    scheme: pinned.scheme,
  };

  try {
    return await new Promise<ObservedHop>((resolve) => {
      const remaining = Math.max(500, Math.min(limits.connectTimeoutMs * 2, deadlineAt - Date.now()));
      const isTls = pinned.scheme === "https:";
      const transport = isTls ? https : http;

      const request = transport.request(
        {
          // We connect to the address we validated, not to the hostname.
          host: pinned.pinnedAddress,
          port: pinned.port,
          path: pinned.pathAndQuery,
          method: "GET",
          headers: { ...FIXED_REQUEST_HEADERS, host: `${pinned.hostname}` },
          // Guarantees the socket uses our validated IP even if the resolver is
          // called again internally.
          lookup: pinned.lookup,
          // Node would otherwise overwrite Host with the IP we connect to.
          setHost: false,
          servername: isTls ? pinned.hostname : undefined,
          rejectUnauthorized: true,
          agent: false,
          family: pinned.pinnedFamily,
        },
        (response) => {
          const headers = headerBag(response.headers);
          let received = 0;
          let settled = false;

          const finish = (extra: Partial<ObservedHop> = {}) => {
            if (settled) return;
            settled = true;
            clearTimeout(inactivityTimer);
            clearTimeout(deadlineTimer);
            resolve({
              ...baseHop,
              statusCode: response.statusCode ?? null,
              headers,
              location: (headers["location"]?.[0] ?? null) as string | null,
              tls: readTls(response.socket ?? null, pinned.hostname),
              responseTimeMs: Date.now() - startedAt,
              error: null,
              ...extra,
            });
            // We never use the body: stop reading and close the socket.
            response.destroy();
            request.destroy();
          };

          response.on("data", (chunk: Buffer) => {
            received += chunk.length;
            if (received > limits.maxResponseBytes) {
              response.destroy();
              request.destroy();
            }
          });
          response.on("error", () => finish());
          response.on("end", () => finish());
          // Headers are all we need — settle immediately so slow bodies or
          // stalled uploads cannot hold the scan open.
          finish();
        },
      );

      const fail = (code: string, message: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(inactivityTimer);
        clearTimeout(deadlineTimer);
        try {
          request.destroy();
        } catch {
          /* already gone */
        }
        resolve({
          ...baseHop,
          statusCode: null,
          headers: {},
          location: null,
          tls: null,
          responseTimeMs: Date.now() - startedAt,
          error: { code, message },
        });
      };

      let settled = false;

      const inactivityTimer = setTimeout(() => {
        fail("timeout", `No response within ${remaining}ms.`);
      }, remaining);

      const deadlineTimer = setTimeout(() => {
        fail("timeout", "Scan time budget exceeded.");
      }, Math.max(500, deadlineAt - Date.now()));

      request.on("socket", (socket) => {
        // Belt and braces: verify where the socket actually went.
        const onConnect = () => {
          try {
            assertRemoteAddressAllowed(socket.remoteAddress, pinned.addresses);
          } catch (error) {
            fail(
              isTargetRejected(error) ? error.code : "ip-blocked",
              error instanceof Error ? error.message : "Connection destination failed validation.",
            );
          }
        };
        if (socket.connecting) socket.once("connect", onConnect);
        else onConnect();
        socket.setTimeout(Math.max(500, remaining), () => {
          fail("timeout", "Socket stalled.");
        });
      });

      request.on("error", (error: NodeJS.ErrnoException) => {
        const code = error.code ?? "network-error";
        fail(code, describeNetworkError(code, error.message, pinned));
      });

      request.end();
    });
  } finally {
    release();
  }
}

function describeNetworkError(code: string, message: string, pinned: PinnedTarget): string {
  if (code === "ENOTFOUND") return `Hostname ${pinned.hostname} could not be resolved.`;
  if (code === "ECONNREFUSED") return `Connection to ${pinned.hostname} was refused.`;
  if (code === "ECONNRESET") return "The connection was reset by the remote server.";
  if (code === "ETIMEDOUT" || code === "ESOCKETTIMEDOUT") return "The connection timed out.";
  if (code === "EAI_AGAIN") return "DNS server was temporarily unavailable.";
  if (code === "EPROTO" || code.startsWith("ERR_SSL") || isCertificateError(code)) {
    return `TLS error (${code}): ${message.split("\n")[0]}`;
  }
  if (code === "EHOSTUNREACH" || code === "ENETUNREACH") return "The host was unreachable from the scanner.";
  return `${code}: ${message.split("\n")[0]}`;
}

// ---------------------------------------------------------------------------
// Redirect chain
// ---------------------------------------------------------------------------

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

async function followChain(
  start: ParsedTarget,
  limits: ScannerLimits,
  deadlineAt: number,
  maxRedirects: number,
  addressLog?: Set<string>,
): Promise<ObservedHop[]> {
  const hops: ObservedHop[] = [];
  let current = start;

  for (let hopIndex = 0; hopIndex <= maxRedirects; hopIndex += 1) {
    if (Date.now() > deadlineAt) {
      hops.push({
        url: current.href,
        hostname: current.hostname,
        scheme: current.scheme,
        statusCode: null,
        headers: {},
        location: null,
        tls: null,
        responseTimeMs: 0,
        error: { code: "timeout", message: "Scan time budget exceeded before this hop." },
      });
      return hops;
    }

    let pinned: PinnedTarget;
    try {
      pinned = await resolveAndPinTarget(current, { timeoutMs: Math.max(1000, Math.min(5000, deadlineAt - Date.now())) });
    } catch (error) {
      const code = isTargetRejected(error) ? error.code : "dns-resolution-failed";
      const message = error instanceof Error ? error.message : "Target validation failed.";
      // A redirect that points somewhere forbidden must stop the chain.
      hops.push({
        url: current.href,
        hostname: current.hostname,
        scheme: current.scheme,
        statusCode: null,
        headers: {},
        location: null,
        tls: null,
        responseTimeMs: 0,
        error: { code, message },
      });
      return hops;
    }

    addressLog?.add(pinned.pinnedAddress);
    const hop = await performRequest(pinned, limits, deadlineAt);
    hops.push(hop);

    if (hop.statusCode === null) return hops;
    if (!REDIRECT_STATUSES.has(hop.statusCode)) return hops;

    if (hopIndex === maxRedirects) {
      hop.error = {
        code: "too-many-redirects",
        message: `Stopped after ${maxRedirects} redirects; the chain did not settle.`,
      };
      return hops;
    }

    const next = validateRedirectLocation(current, hop.location ?? undefined);
    if (!next) {
      hop.error = {
        code: "redirect-not-allowed",
        message: hop.location
          ? `Redirect to "${hop.location.slice(0, 200)}" was refused by the SSRF policy or could not be parsed.`
          : "Redirect status without a usable Location header.",
      };
      return hops;
    }
    current = next;
  }

  return hops;
}

// ---------------------------------------------------------------------------
// Full observation
// ---------------------------------------------------------------------------

function originTarget(base: ParsedTarget, scheme: "http:" | "https:"): ParsedTarget {
  const port = scheme === "https:" ? 443 : 80;
  const href = `${scheme}//${base.hostname}${base.pathAndQuery}`;
  return { ...base, href, scheme, port };
}

/**
 * Observe a target. Throws `TargetRejectedError` when the submitted URL itself
 * is refused (nothing was sent). Probe failures never throw — they are recorded
 * as evidence.
 */
export async function observeTarget(inputUrl: string, limits = getScannerLimits()): Promise<Observation> {
  const startedAt = Date.now();
  const deadlineAt = startedAt + limits.scanBudgetMs;
  const target = parseTargetUrl(inputUrl);

  const chainBudget: ScannerLimits = { ...limits, totalTimeoutMs: limits.totalTimeoutMs };
  const probeMaxRedirects = Math.min(3, limits.maxRedirects);
  // Every address we actually opened a socket to, across all probes.
  const addressLog = new Set<string>();

  const primaryPromise = followChain(target, chainBudget, deadlineAt, limits.maxRedirects, addressLog);

  const httpsProbe =
    target.scheme === "https:"
      ? null
      : followChain(originTarget(target, "https:"), chainBudget, deadlineAt, probeMaxRedirects, addressLog).catch(
          (error: unknown) => [errorHop(target, "https:", error)],
        );

  const httpProbe =
    target.scheme === "http:"
      ? null
      : followChain(originTarget(target, "http:"), chainBudget, deadlineAt, probeMaxRedirects, addressLog).catch(
          (error: unknown) => [errorHop(target, "http:", error)],
        );

  const [primaryChain, probedHttps, probedHttp] = await Promise.all([primaryPromise, httpsProbe, httpProbe]);

  // When the user submitted https://, the primary chain *is* the HTTPS
  // evidence (and vice versa for http://). Without this the HTTPS-availability
  // and HTTP-upgrade checks would have nothing to inspect for exactly the
  // scheme the user asked about.
  const httpsChain = target.scheme === "https:" ? primaryChain : (probedHttps ?? []);
  const httpChain = target.scheme === "http:" ? primaryChain : (probedHttp ?? []);

  return {
    inputUrl: target.inputUrl,
    requestedUrl: target.href,
    requestedScheme: target.scheme,
    primaryChain,
    httpsChain,
    httpChain,
    resolvedAddresses: [...addressLog],
    pinnedAddress: [...addressLog][0] ?? null,
    userAgent: SCANNER_USER_AGENT,
    scannedAt: new Date(startedAt).toISOString(),
    totalDurationMs: Date.now() - startedAt,
  };
}

function errorHop(target: ParsedTarget, scheme: "http:" | "https:", error: unknown): ObservedHop {
  return {
    url: `${scheme}//${target.hostname}${target.pathAndQuery}`,
    hostname: target.hostname,
    scheme,
    statusCode: null,
    headers: {},
    location: null,
    tls: null,
    responseTimeMs: 0,
    error: {
      code: isTargetRejected(error) ? error.code : "network-error",
      message: error instanceof Error ? error.message : "Probe failed.",
    },
  };
}
