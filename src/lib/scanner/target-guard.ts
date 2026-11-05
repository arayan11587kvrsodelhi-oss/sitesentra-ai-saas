/**
 * SiteSentra — SSRF target guard.
 *
 * THIS FILE IS THE SECURITY BOUNDARY between user-supplied URLs and the network.
 * Nothing in the scanner is allowed to open a socket without going through
 * `parseTargetUrl()` + `resolveAndPinTarget()` first.
 *
 * Threat model (what we defend against):
 *  1. Direct requests to loopback / private / link-local / reserved ranges
 *     (IPv4 *and* IPv6), including the cloud metadata addresses
 *     169.254.169.254 and fd00:ec2::254.
 *  2. Non-IP schemes (file:, gopher:, dict:, data:, ftp:, ws: …).
 *  3. Credentials smuggled in the URL (http://user:pass@host/).
 *  4. Ambiguous / obfuscated host encodings: decimal (2130706433), hex
 *     (0x7f000001), octal (0177.0.0.1), short forms (127.1), IPv6 zone ids.
 *  5. Internal-only names: localhost, *.local, *.internal, *.lan, metadata.
 *  6. Port scanning: only the scheme's default port (80/443) is accepted.
 *  7. DNS rebinding / TOCTOU: DNS is resolved *once* by us, every returned
 *     address is validated, and the socket is then pinned to one validated
 *     address through a `lookup` override. The remote address is re-checked
 *     after the connection is established.
 *  8. Redirect-based bypasses: redirects are followed manually and every hop is
 *     re-parsed, re-resolved and re-validated with the exact same rules.
 *
 * Fail-safe rule used everywhere below: when something is ambiguous, we reject.
 *
 * NOTE: this module intentionally has no relative imports so it can be executed
 * directly by `node --test` (type stripping) without a bundler.
 */
import { promises as dnsPromises } from "node:dns";
import net from "node:net";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Machine-readable rejection codes. Safe to show to a user (no internals). */
export type RejectCode =
  | "empty-url"
  | "url-too-long"
  | "control-characters"
  | "malformed-url"
  | "missing-scheme"
  | "unsupported-scheme"
  | "credentials-in-url"
  | "missing-host"
  | "invalid-hostname"
  | "hostname-too-long"
  | "blocked-hostname"
  | "ambiguous-ip-literal"
  | "port-not-allowed"
  | "ip-blocked"
  | "dns-resolution-failed"
  | "dns-no-addresses"
  | "redirect-not-allowed"
  | "too-many-redirects";

export class TargetRejectedError extends Error {
  readonly code: RejectCode;
  constructor(code: RejectCode, message: string) {
    super(message);
    this.name = "TargetRejectedError";
    this.code = code;
  }
}

export function isTargetRejected(error: unknown): error is TargetRejectedError {
  return error instanceof TargetRejectedError;
}

// ---------------------------------------------------------------------------
// Policy constants (deliberate, documented choices)
// ---------------------------------------------------------------------------

export const MAX_URL_LENGTH = 2048;
export const MAX_HOSTNAME_LENGTH = 253;
export const MAX_LABEL_LENGTH = 63;
export const MAX_REDIRECTS = 5;

/** Only these schemes may ever be requested. */
export const ALLOWED_SCHEMES = ["http:", "https:"] as const;
export type AllowedScheme = (typeof ALLOWED_SCHEMES)[number];

export const DEFAULT_PORT_FOR_SCHEME: Record<AllowedScheme, number> = {
  "http:": 80,
  "https:": 443,
};

/**
 * Port policy: default ports only.
 * Allowing arbitrary ports would turn SiteSentra into a port scanner that can
 * be pointed at internal services, so we reject them outright.
 */
const ALLOW_NON_DEFAULT_PORTS = false;

const BLOCKED_EXACT_HOSTNAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "ip6-localhost",
  "ip6-loopback",
  "metadata",
  "metadata.google.internal",
  "metadata.goog",
  "instance-data",
  "instance-metadata",
]);

const BLOCKED_HOSTNAME_SUFFIXES = [
  ".localhost",
  ".local",
  ".internal",
  ".intranet",
  ".lan",
  ".home",
  ".corp",
  ".private",
  ".test",
  ".invalid",
  ".localdomain",
];

// ---------------------------------------------------------------------------
// IPv4 helpers (including obfuscated forms, which we detect and reject)
// ---------------------------------------------------------------------------

function parseIpv4DottedStrict(host: string): number | null {
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    value = value * 256 + n;
  }
  return value >>> 0;
}

function ipv4ToText(value: number): string {
  return [
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ].join(".");
}

/**
 * Detects obfuscated IPv4 host spellings: `2130706433`, `0x7f000001`,
 * `0177.0.0.1`, `127.1`, `127.0.1`. These are resolved by libc's inet_aton but
 * hide the real destination from a human reviewer, so we reject them as
 * ambiguous instead of silently connecting.
 */
export function looksLikeObfuscatedIpv4(host: string): boolean {
  if (host.includes(":")) return false;
  const parts = host.split(".");
  if (parts.length > 4) return false;

  // Only inet_aton-style numeric tokens can be an obfuscated IPv4 address.
  // Anything containing normal DNS characters (example.com, localhost,
  // printer.local) is NOT numeric and must be handled by the DNS path.
  const numericToken = /^(0x[0-9a-fA-F]+|0[0-7]*|[1-9][0-9]*)$/;
  if (!parts.every((part) => numericToken.test(part))) return false;

  // A plain dotted-quad with no leading zeros is the unambiguous form.
  const isPlainDottedQuad =
    parts.length === 4 && parts.every((part) => /^\d{1,3}$/.test(part) && !/^0\d+$/.test(part));
  if (isPlainDottedQuad) return false;

  // Everything else numeric is an obfuscation attempt: a single 32-bit integer,
  // a hex blob, octal parts, or a short form.
  return true;
}

// ---------------------------------------------------------------------------
// IPv6 helpers
// ---------------------------------------------------------------------------

/** Expands an IPv6 address into 8 16-bit groups. Returns null when invalid. */
export function ipv6Groups(address: string): number[] | null {
  if (address.includes("%")) return null; // zone ids are ambiguous — reject
  const halves = address.split("::");
  if (halves.length > 2) return null;

  const parseSide = (side: string): number[] | null => {
    if (side === "") return [];
    const segments = side.split(":");
    const out: number[] = [];
    for (let i = 0; i < segments.length; i += 1) {
      const segment = segments[i];
      if (segment.includes(".")) {
        if (i !== segments.length - 1) return null; // embedded IPv4 must be last
        const v4 = parseIpv4DottedStrict(segment);
        if (v4 === null) return null;
        out.push((v4 >>> 16) & 0xffff, v4 & 0xffff);
        continue;
      }
      if (!/^[0-9a-fA-F]{1,4}$/.test(segment)) return null;
      out.push(parseInt(segment, 16));
    }
    return out;
  };

  const left = parseSide(halves[0]);
  if (left === null) return null;

  if (halves.length === 1) {
    return left.length === 8 ? left : null;
  }

  const right = parseSide(halves[1]);
  if (right === null) return null;
  const missing = 8 - left.length - right.length;
  if (missing < 1) return null;
  return [...left, ...new Array<number>(missing).fill(0), ...right];
}

function ipv6ToBigInt(address: string): bigint | null {
  const groups = ipv6Groups(address);
  if (!groups) return null;
  let value = 0n;
  for (const group of groups) value = (value << 16n) | BigInt(group);
  return value;
}

function inCidr(address: string, cidr: string, family: 4 | 6): boolean {
  const [base, prefixText] = cidr.split("/");
  const prefix = Number(prefixText);
  if (family === 4) {
    const a = parseIpv4DottedStrict(address);
    const b = parseIpv4DottedStrict(base);
    if (a === null || b === null) return false;
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    return (a & mask) === (b & mask);
  }
  const a = ipv6ToBigInt(address);
  const b = ipv6ToBigInt(base);
  if (a === null || b === null) return false;
  const mask = prefix === 0 ? 0n : ((1n << BigInt(prefix)) - 1n) << BigInt(128 - prefix);
  return (a & mask) === (b & mask);
}

// ---------------------------------------------------------------------------
// IP classification
// ---------------------------------------------------------------------------

export type IpVerdict = {
  allowed: boolean;
  /** Human-readable bucket, surfaced as evidence in the report. */
  category: string;
  address: string;
  family: 4 | 6;
};

const IPV4_BLOCKED_RANGES: Array<[string, string]> = [
  ["0.0.0.0/8", "this-network"],
  ["10.0.0.0/8", "private (RFC1918)"],
  ["100.64.0.0/10", "carrier-grade NAT (RFC6598)"],
  ["127.0.0.0/8", "loopback"],
  ["169.254.0.0/16", "link-local / cloud metadata"],
  ["172.16.0.0/12", "private (RFC1918)"],
  ["192.0.0.0/24", "IETF protocol assignments"],
  ["192.0.2.0/24", "documentation (TEST-NET-1)"],
  ["192.88.99.0/24", "6to4 relay anycast (deprecated)"],
  ["192.168.0.0/16", "private (RFC1918)"],
  ["198.18.0.0/15", "benchmarking (RFC2544)"],
  ["198.51.100.0/24", "documentation (TEST-NET-2)"],
  ["203.0.113.0/24", "documentation (TEST-NET-3)"],
  ["224.0.0.0/4", "multicast"],
  ["240.0.0.0/4", "reserved / future use"],
  ["255.255.255.255/32", "limited broadcast"],
];

const IPV6_BLOCKED_RANGES: Array<[string, string]> = [
  ["::/128", "unspecified"],
  ["::1/128", "loopback"],
  ["::/96", "IPv4-compatible (deprecated)"],
  ["::ffff:0:0/96", "IPv4-mapped"],
  ["64:ff9b::/96", "NAT64 embedded IPv4"],
  ["64:ff9b:1::/48", "local-use NAT64"],
  ["100::/64", "discard-only"],
  ["2001::/32", "Teredo"],
  ["2001:db8::/32", "documentation"],
  ["2002::/16", "6to4"],
  ["3fff::/20", "documentation (RFC9637)"],
  ["5f00::/8", "SRv6 segment routing"],
  ["fc00::/7", "unique local address"],
  ["fe80::/10", "link-local"],
  ["ff00::/8", "multicast"],
];

function classifyIpv4(address: string): IpVerdict {
  for (const [cidr, category] of IPV4_BLOCKED_RANGES) {
    if (inCidr(address, cidr, 4)) {
      return { allowed: false, category, address, family: 4 };
    }
  }
  return { allowed: true, category: "public unicast", address, family: 4 };
}

function classifyIpv6(address: string): IpVerdict {
  const denied = (category: string): IpVerdict => ({
    allowed: false,
    category,
    address,
    family: 6,
  });

  for (const [cidr, category] of IPV6_BLOCKED_RANGES) {
    if (inCidr(address, cidr, 6)) {
      // For addresses that *embed* an IPv4 address, also classify the embedded
      // value so an attacker cannot reach 127.0.0.1 via ::ffff:127.0.0.1,
      // 64:ff9b::7f00:1, 2002:7f00:1:: (6to4) or Teredo.
      const groups = ipv6Groups(address);
      if (groups) {
        const embedded =
          ((BigInt(groups[6]) << 16n) | BigInt(groups[7])) & 0xffffffffn;
        const embeddedText = ipv4ToText(Number(embedded));
        const embeddedVerdict = classifyIpv4(embeddedText);
        if (!embeddedVerdict.allowed) {
          return denied(`${category} → embedded IPv4 ${embeddedText} (${embeddedVerdict.category})`);
        }
        if (inCidr(address, "2001::/32", 6)) {
          // Teredo client IPv4 is the bitwise complement of the last 32 bits.
          const complement = ~embedded & 0xffffffffn;
          const complementText = ipv4ToText(Number(complement));
          const complementVerdict = classifyIpv4(complementText);
          if (!complementVerdict.allowed) {
            return denied(`${category} → Teredo client IPv4 ${complementText} (${complementVerdict.category})`);
          }
        }
      }
      if (
          inCidr(address, "::/96", 6) ||
          inCidr(address, "::ffff:0:0/96", 6) ||
          inCidr(address, "64:ff9b::/96", 6)
        ) {
          // Embedded IPv4 was public — still refuse: transition/mapped formats
          // are ambiguous on the open internet and a classic SSRF smuggling
          // trick, so we fail closed rather than connect.
          return denied(`${category} (transition addressing refused)`);
        }
      return denied(category);
    }
  }
  return { allowed: true, category: "global unicast", address, family: 6 };
}

/** Classify any IP literal. Returns null when `address` is not an IP at all. */
export function classifyIp(address: string): IpVerdict | null {
  const bare = address.split("%")[0];
  if (net.isIPv4(bare)) return classifyIpv4(bare);
  if (net.isIPv6(bare)) return classifyIpv6(bare);
  return null;
}

export function isBlockedIp(address: string): boolean {
  const verdict = classifyIp(address);
  // Unknown formats are treated as blocked (fail closed).
  return verdict === null ? true : !verdict.allowed;
}

// ---------------------------------------------------------------------------
// URL parsing / validation
// ---------------------------------------------------------------------------

export type ParsedTarget = {
  /** The URL we will actually request (credentials/fragment removed). */
  href: string;
  scheme: AllowedScheme;
  /** Normalised hostname: lower-case, no brackets, no trailing dot. */
  hostname: string;
  port: number;
  /** Set when the hostname is an IP literal (already classified as allowed). */
  ipLiteral: string | null;
  /** Path + query we request. Host header never comes from this. */
  pathAndQuery: string;
  /** Exactly what the user typed (length-capped, control chars rejected). */
  inputUrl: string;
};

function assertHostnameShape(hostname: string): void {
  if (hostname.length > MAX_HOSTNAME_LENGTH) {
    throw new TargetRejectedError("hostname-too-long", "Hostname exceeds 253 characters.");
  }
  const labels = hostname.split(".");
  if (labels.some((label) => label.length > MAX_LABEL_LENGTH)) {
    throw new TargetRejectedError("invalid-hostname", "A hostname label exceeds 63 characters.");
  }
  if (labels.some((label) => label.length === 0)) {
    throw new TargetRejectedError("invalid-hostname", "Hostname contains an empty label.");
  }
  // After WHATWG normalisation a hostname is punycode + [a-z0-9-.]; IPv6 keeps
  // hex digits and colons inside brackets (already stripped by the caller).
  if (!/^[a-z0-9._\-:]+$/i.test(hostname)) {
    throw new TargetRejectedError(
      "invalid-hostname",
      "Hostname contains characters that are not allowed in a DNS name.",
    );
  }
  if (/^-|-$/.test(hostname) || labels.some((l) => /^-|-$/.test(l))) {
    throw new TargetRejectedError("invalid-hostname", "Hostname labels may not start or end with a hyphen.");
  }
  // A hostname must contain at least one dot (public FQDN) or be an IP literal.
  // This blocks single-label internal names such as `intranet` or `printer`.
  if (!hostname.includes(".")) {
    throw new TargetRejectedError(
      "invalid-hostname",
      "Single-label hostnames are not accepted. Use a fully qualified public domain name.",
    );
  }
}

/**
 * Parse and validate a user-supplied URL. Throws `TargetRejectedError`.
 * A scheme is mandatory: `example.com` is rejected as ambiguous rather than
 * guessed at (the UI adds `https://` explicitly before submitting).
 */
export function parseTargetUrl(input: unknown): ParsedTarget {
  if (typeof input !== "string") {
    throw new TargetRejectedError("empty-url", "A URL string is required.");
  }
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    throw new TargetRejectedError("empty-url", "Enter a URL to check, for example https://example.com");
  }
  if (trimmed.length > MAX_URL_LENGTH) {
    throw new TargetRejectedError("url-too-long", `URLs are limited to ${MAX_URL_LENGTH} characters.`);
  }

  if (/[\u0000-\u0020\u007f]/.test(trimmed)) {
    throw new TargetRejectedError(
      "control-characters",
      "URL contains whitespace or control characters, which can be used to smuggle requests.",
    );
  }
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)) {
    throw new TargetRejectedError(
      "missing-scheme",
      "Include the scheme, for example https://example.com (a bare hostname is ambiguous).",
    );
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new TargetRejectedError("malformed-url", "That URL could not be parsed.");
  }

  const scheme = url.protocol.toLowerCase();
  if (scheme !== "http:" && scheme !== "https:") {
    throw new TargetRejectedError(
      "unsupported-scheme",
      `Only http:// and https:// targets are allowed (received "${url.protocol}").`,
    );
  }
  if (url.username !== "" || url.password !== "") {
    throw new TargetRejectedError(
      "credentials-in-url",
      "URLs containing embedded credentials (user:pass@host) are rejected.",
    );
  }
  if (url.hostname === "") {
    throw new TargetRejectedError("missing-host", "The URL has no hostname.");
  }

  // WHATWG keeps brackets around IPv6 literals — strip them for classification.
  let hostname = url.hostname;
  let ipLiteral: string | null = null;
  if (hostname.startsWith("[") && hostname.endsWith("]")) {
    const inner = hostname.slice(1, -1);
    if (!net.isIPv6(inner)) {
      throw new TargetRejectedError("ambiguous-ip-literal", "Malformed IPv6 literal.");
    }
    if (inner.includes("%")) {
      throw new TargetRejectedError("ambiguous-ip-literal", "IPv6 zone identifiers are not accepted.");
    }
    hostname = inner;
    ipLiteral = inner;
  } else {
    // Trailing root dot is legal in DNS but changes string comparisons; normalise.
    hostname = hostname.replace(/\.$/, "").toLowerCase();
    if (net.isIPv4(hostname)) {
      ipLiteral = hostname;
    } else if (net.isIPv6(hostname) || looksLikeObfuscatedIpv4(hostname)) {
      throw new TargetRejectedError(
        "ambiguous-ip-literal",
        "Obfuscated IP host spellings (decimal, hex, octal or short-form IPv4) are rejected. Use a domain name or a normal dotted-quad address.",
      );
    }
  }

  // Explicit deny-list first: `localhost` must be reported as a blocked
  // internal name, not as a merely malformed hostname.
  const lowerHost = hostname.toLowerCase();
  if (BLOCKED_EXACT_HOSTNAMES.has(lowerHost)) {
    throw new TargetRejectedError("blocked-hostname", `"${hostname}" resolves to an internal name and is not a valid public target.`);
  }
  if (BLOCKED_HOSTNAME_SUFFIXES.some((suffix) => lowerHost.endsWith(suffix))) {
    throw new TargetRejectedError("blocked-hostname", `"${hostname}" is in an internal-only namespace and cannot be scanned.`);
  }

  if (ipLiteral === null) assertHostnameShape(hostname);

  // Classify IP literals up front — before any DNS or socket work.
  if (ipLiteral !== null) {
    const verdict = classifyIp(ipLiteral);
    if (!verdict || !verdict.allowed) {
      throw new TargetRejectedError(
        "ip-blocked",
        `Refusing to connect to ${ipLiteral}: ${verdict ? verdict.category : "unrecognised address format"}.`,
      );
    }
  }

  // Port policy.
  let port = DEFAULT_PORT_FOR_SCHEME[scheme];
  if (url.port !== "") {
    const explicit = Number(url.port);
    if (!Number.isInteger(explicit) || explicit <= 0 || explicit > 65535) {
      throw new TargetRejectedError("port-not-allowed", "Invalid port in URL.");
    }
    if (explicit !== DEFAULT_PORT_FOR_SCHEME[scheme]) {
      if (!ALLOW_NON_DEFAULT_PORTS) {
        throw new TargetRejectedError(
          "port-not-allowed",
          `Only default ports are allowed (80 for http, 443 for https). Port ${explicit} was rejected to prevent port scanning.`,
        );
      }
      port = explicit;
    }
  }

  const pathAndQuery = `${url.pathname || "/"}${url.search}`;
  const rebuilt = new URL(`${scheme}//${url.host}${pathAndQuery}`);

  return {
    href: rebuilt.toString(),
    scheme,
    hostname,
    port,
    ipLiteral,
    pathAndQuery: pathAndQuery.length > 1024 ? pathAndQuery.slice(0, 1024) : pathAndQuery,
    inputUrl: trimmed,
  };
}

// ---------------------------------------------------------------------------
// DNS resolution + address pinning
// ---------------------------------------------------------------------------

export type PinnedTarget = ParsedTarget & {
  /** Every address DNS returned, all of which passed classification. */
  addresses: string[];
  /** The single address the socket must connect to. */
  pinnedAddress: string;
  pinnedFamily: 4 | 6;
  /**
   * Drop-in `lookup` override for http/https.request. It ignores the hostname
   * and always returns the pre-validated address, which removes the
   * time-of-check/time-of-use window used by DNS rebinding attacks.
   */
  lookup: (
    hostname: string,
    options: unknown,
    callback: (error: NodeJS.ErrnoException | null, address: string, family: number) => void,
  ) => void;
};

export type ResolveOptions = {
  timeoutMs?: number;
};

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new TargetRejectedError("dns-resolution-failed", `${label} timed out after ${ms}ms.`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Resolve a parsed target and pin the connection to a validated address.
 * Every address returned by DNS is classified; a single blocked address fails
 * the whole target (fail closed — we will not "pick a good one" from a host that
 * is deliberately mixing public and internal answers).
 */
export async function resolveAndPinTarget(
  target: ParsedTarget,
  options: ResolveOptions = {},
): Promise<PinnedTarget> {
  const timeoutMs = options.timeoutMs ?? 5000;

  if (target.ipLiteral !== null) {
    const family: 4 | 6 = net.isIPv4(target.ipLiteral) ? 4 : 6;
    return buildPinned(target, [target.ipLiteral], family);
  }

  // Uses the system resolver configuration. We deliberately do not override
  // nameservers: the guard's safety comes from classifying the addresses that
  // come back, not from choosing who answers.
  const resolver = new dnsPromises.Resolver();

  const [v4, v6] = await Promise.all([
    withTimeout(resolver.resolve4(target.hostname).catch(() => [] as string[]), timeoutMs, "DNS A lookup"),
    withTimeout(resolver.resolve6(target.hostname).catch(() => [] as string[]), timeoutMs, "DNS AAAA lookup"),
  ]).catch((error) => {
    throw new TargetRejectedError(
      "dns-resolution-failed",
      `Could not resolve ${target.hostname}: ${error instanceof Error ? error.message : "unknown error"}`,
    );
  });

  const addresses = [...v4, ...v6];
  if (addresses.length === 0) {
    throw new TargetRejectedError(
      "dns-no-addresses",
      `${target.hostname} did not resolve to any IP address.`,
    );
  }

  for (const address of addresses) {
    const verdict = classifyIp(address);
    if (!verdict || !verdict.allowed) {
      throw new TargetRejectedError(
        "ip-blocked",
        `${target.hostname} resolves to ${address} (${verdict ? verdict.category : "unrecognised address"}), which is not a permitted public destination.`,
      );
    }
  }

  // Prefer IPv4 for determinism inside sandboxes/CI without IPv6 egress.
  const family: 4 | 6 = v4.length > 0 ? 4 : 6;
  return buildPinned(target, addresses, family);
}

function buildPinned(target: ParsedTarget, addresses: string[], family: 4 | 6): PinnedTarget {
  const pinnedAddress = addresses.find((a) => (family === 4 ? net.isIPv4(a) : net.isIPv6(a))) ?? addresses[0];
  return {
    ...target,
    addresses,
    pinnedAddress,
    pinnedFamily: net.isIPv4(pinnedAddress) ? 4 : 6,
    lookup: (_hostname, _options, callback) => {
      // Ignore the hostname entirely: connect only to the address we validated.
      callback(null, pinnedAddress, net.isIPv4(pinnedAddress) ? 4 : 6);
    },
  };
}

/**
 * Post-connection check. Even with pinning we verify the address the socket
 * really ended up on, because proxies/agents can change the destination.
 */
export function assertRemoteAddressAllowed(remoteAddress: string | undefined, allowed: string[]): void {
  if (!remoteAddress) {
    throw new TargetRejectedError("ip-blocked", "Connection reported no remote address; aborting.");
  }
  const bare = remoteAddress.split("%")[0];
  const verdict = classifyIp(bare);
  if (!verdict || !verdict.allowed) {
    throw new TargetRejectedError(
      "ip-blocked",
      `Connection reached ${bare} (${verdict ? verdict.category : "unrecognised"}), which is not permitted.`,
    );
  }
  if (!allowed.includes(bare)) {
    throw new TargetRejectedError(
      "ip-blocked",
      `Connection reached ${bare}, which was not in the validated address set [${allowed.join(", ")}]. Possible DNS rebinding — aborted.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Redirect validation
// ---------------------------------------------------------------------------

/**
 * Validate a `Location` header for the next hop.
 * The candidate is re-parsed with the identical policy, so a redirect cannot
 * downgrade into an internal address, a non-default port, or another scheme.
 * Returns null when the redirect is unusable (caller records it and stops).
 */
export function validateRedirectLocation(
  current: ParsedTarget,
  location: string | undefined,
): ParsedTarget | null {
  if (!location) return null;
  const trimmedLocation = location.trim();
  if (trimmedLocation.length === 0 || trimmedLocation.length > MAX_URL_LENGTH) return null;

  if (/[\u0000-\u0020\u007f]/.test(trimmedLocation)) return null;

  let candidateHref: string;
  try {
    candidateHref = new URL(trimmedLocation, current.href).toString();
  } catch {
    return null;
  }

  try {
    return parseTargetUrl(candidateHref);
  } catch {
    return null;
  }
}
