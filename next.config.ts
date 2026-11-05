import type { NextConfig } from "next";

/**
 * Security headers that SiteSentra serves on itself.
 *
 * Documented limitation: Next.js App Router streams inline `<script>` tags for
 * its client payload, so a strict `script-src` requires per-request nonces from
 * a middleware/proxy. Until that is added, `script-src` allows 'unsafe-inline'
 * (plus 'unsafe-eval' for compatibility), which means CSP here mitigates
 * content-injection and framing risks but would NOT fully stop an injected
 * inline script. Everything else below is enforced strictly.
 * See docs/SECURITY.md → "Known limitations".
 */
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "object-src 'none'",
  "upgrade-insecure-requests",
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: CONTENT_SECURITY_POLICY },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()",
  },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
  // Only honoured by browsers over HTTPS; harmless on local http.
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
  { key: "X-Powered-By", value: "" },
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: securityHeaders.filter((header) => header.value !== ""),
      },
    ];
  },
};

export default nextConfig;
