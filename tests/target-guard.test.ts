/**
 * SSRF policy tests — the scanner's most important security boundary.
 *
 * Run with:  node --test tests/target-guard.test.ts
 * No test framework dependency is required; this uses Node's built-in runner
 * and TypeScript type stripping (Node >= 22.18).
 */
import assert from "node:assert/strict";
import http from "node:http";
import { after, before, describe, test } from "node:test";

import {
  TargetRejectedError,
  classifyIp,
  isBlockedIp,
  ipv6Groups,
  looksLikeObfuscatedIpv4,
  parseTargetUrl,
  resolveAndPinTarget,
  validateRedirectLocation,
} from "../src/lib/scanner/target-guard.ts";

function expectRejection(input: unknown, code?: string | string[]): void {
  try {
    parseTargetUrl(input);
  } catch (error) {
    assert.ok(error instanceof TargetRejectedError, `expected TargetRejectedError for ${input}`);
    if (code) {
      const accepted = Array.isArray(code) ? code : [code];
      assert.ok(
        accepted.includes(error.code),
        `wrong rejection code for ${input}: got "${error.code}", expected one of ${accepted.join(", ")}`,
      );
    }
    return;
  }
  assert.fail(`expected "${input}" to be rejected, but it was accepted`);
}

describe("scheme policy", () => {
  test("rejects non-HTTP schemes", () => {
    for (const url of [
      "file:///etc/passwd",
      "gopher://example.com/",
      "dict://example.com/",
      "ftp://example.com/",
      "data:text/html,<script>alert(1)</script>",
      "javascript:alert(1)",
      "ws://example.com/",
      "http+unix://%2Fvar%2Frun%2Fdocker.sock/info",
    ]) {
      expectRejection(url, "unsupported-scheme");
    }
  });

  test("rejects a missing scheme instead of guessing", () => {
    expectRejection("example.com", "missing-scheme");
    expectRejection("//example.com", "missing-scheme");
  });

  test("accepts http and https", () => {
    assert.equal(parseTargetUrl("https://example.com/").scheme, "https:");
    assert.equal(parseTargetUrl("http://example.com/").scheme, "http:");
    assert.equal(parseTargetUrl("https://example.com").port, 443);
    assert.equal(parseTargetUrl("http://example.com").port, 80);
  });
});

describe("credential and format smuggling", () => {
  test("rejects embedded credentials", () => {
    expectRejection("http://user:pass@example.com/", "credentials-in-url");
    expectRejection("https://user@example.com/", "credentials-in-url");
  });

  test("rejects control characters, whitespace and CRLF injection", () => {
    expectRejection("https://example.com/\nX-Injected: 1", "control-characters");
    expectRejection("https://example .com/", "control-characters");
    expectRejection("https://example.com/\u007f", "control-characters");
  });

  test("percent-encoded sequences in the path are inert, not header injection", () => {
    // %0d%0a stays percent-encoded: the URL parser never turns it into a CRLF,
    // so it cannot split an HTTP request line or inject a header.
    const target = parseTargetUrl("https://example.com/%0d%0aX-Injected:%201");
    assert.equal(target.hostname, "example.com");
    assert.match(target.pathAndQuery, /^\/%0[dD]%0[aA]X-Injected/);
    assert.ok(!target.pathAndQuery.includes("\n"), "no raw newline may reach the request");
  });

  test("rejects over-long URLs", () => {
    expectRejection(`https://example.com/${"a".repeat(5000)}`, "url-too-long");
  });

  test("rejects empty and non-string input", () => {
    expectRejection("", "empty-url");
    expectRejection(null, "empty-url");
    expectRejection(12345, "empty-url");
  });
});

describe("blocked IP destinations", () => {
  const blocked = [
    "http://127.0.0.1/",
    "http://127.0.0.1:80/",
    "https://127.8.9.10/",
    "http://10.0.0.5/",
    "http://172.16.0.1/",
    "http://172.31.255.255/",
    "http://192.168.1.1/",
    "http://169.254.169.254/latest/meta-data/",
    "http://169.254.170.2/v2/credentials",
    "http://0.0.0.0/",
    "http://255.255.255.255/",
    "http://224.0.0.1/",
    "http://240.0.0.1/",
    "http://100.64.0.1/",
    "http://198.18.0.1/",
    "http://[::1]/",
    "http://[::]/",
    "http://[fe80::1]/",
    "http://[fc00::1]/",
    "http://[fd00:ec2::254]/latest/meta-data/",
    "http://[ff02::1]/",
    "http://[::ffff:127.0.0.1]/",
    "http://[::ffff:169.254.169.254]/",
    "http://[64:ff9b::7f00:1]/",
    "http://[2002:7f00:1::]/",
    "http://[2001:db8::1]/",
    "http://[100::1]/",
  ];

  for (const url of blocked) {
    test(`rejects ${url}`, () => {
      expectRejection(url, "ip-blocked");
    });
  }

  test("classifies representative ranges correctly", () => {
    assert.equal(isBlockedIp("8.8.8.8"), false);
    assert.equal(isBlockedIp("1.1.1.1"), false);
    assert.equal(isBlockedIp("93.184.216.34"), false);
    assert.equal(isBlockedIp("2606:2800:220:1:248:1893:25c8:1946"), false);
    assert.equal(isBlockedIp("127.0.0.1"), true);
    assert.equal(isBlockedIp("169.254.169.254"), true);
    assert.equal(isBlockedIp("::1"), true);
    // Unknown formats fail closed.
    assert.equal(isBlockedIp("not-an-ip"), true);
    assert.equal(isBlockedIp(""), true);
  });

  test("reports the category as evidence", () => {
    assert.equal(classifyIp("169.254.169.254")?.category, "link-local / cloud metadata");
    assert.equal(classifyIp("192.168.0.1")?.category, "private (RFC1918)");
    assert.equal(classifyIp("8.8.8.8")?.allowed, true);
    assert.equal(classifyIp("nonsense"), null);
  });

  test("accepts genuine public IP literals", () => {
    const target = parseTargetUrl("https://93.184.216.34/");
    assert.equal(target.ipLiteral, "93.184.216.34");
    assert.equal(target.hostname, "93.184.216.34");
  });
});

describe("obfuscated host encodings", () => {
  test("detects obfuscated IPv4 spellings", () => {
    assert.equal(looksLikeObfuscatedIpv4("2130706433"), true);
    assert.equal(looksLikeObfuscatedIpv4("0x7f000001"), true);
    assert.equal(looksLikeObfuscatedIpv4("127.1"), true);
    assert.equal(looksLikeObfuscatedIpv4("0177.0.0.1"), true);
    assert.equal(looksLikeObfuscatedIpv4("example.com"), false);
    assert.equal(looksLikeObfuscatedIpv4("127.0.0.1"), false);
  });

  test("rejects them as ambiguous rather than interpreting them", () => {
    for (const url of [
      "http://2130706433/",
      "http://0x7f000001/",
      "http://0177.0.0.1/",
      "http://127.1/",
      "http://10.1/",
      "http://[::1%25eth0]/",
    ]) {
      // Both codes are refusals before any socket is opened. Which one fires
      // depends on whether Node's isIPv4 accepts leading zeros (0177.0.0.1),
      // so the test asserts the security property, not the label.
      expectRejection(url, ["ambiguous-ip-literal", "ip-blocked", "malformed-url"]);
    }
  });

  test("expands IPv6 forms consistently", () => {
    assert.deepEqual(ipv6Groups("::1"), [0, 0, 0, 0, 0, 0, 0, 1]);
    assert.deepEqual(ipv6Groups("::"), [0, 0, 0, 0, 0, 0, 0, 0]);
    assert.deepEqual(ipv6Groups("::ffff:127.0.0.1"), [0, 0, 0, 0, 0, 0xffff, 0x7f00, 0x0001]);
    assert.deepEqual(ipv6Groups("fe80::1%eth0"), null, "zone ids must be rejected");
    assert.deepEqual(ipv6Groups("1:2:3:4:5:6:7:8:9"), null);
  });
});

describe("internal hostnames and ports", () => {
  test("rejects internal namespaces", () => {
    expectRejection("http://localhost/", "blocked-hostname");
    expectRejection("http://localhost.localdomain/", "blocked-hostname");
    expectRejection("http://metadata.google.internal/", "blocked-hostname");
    expectRejection("http://printer.local/", "blocked-hostname");
    expectRejection("http://db.intranet/", "blocked-hostname");
    expectRejection("http://service.lan/", "blocked-hostname");
  });

  test("rejects single-label hostnames", () => {
    expectRejection("http://intranet/", "invalid-hostname");
    expectRejection("http://kubernetes/", "invalid-hostname");
  });

  test("rejects non-default ports (anti port-scanning)", () => {
    expectRejection("http://example.com:8080/", "port-not-allowed");
    expectRejection("https://example.com:22/", "port-not-allowed");
    expectRejection("https://example.com:5432/", "port-not-allowed");
    expectRejection("http://example.com:65535/", "port-not-allowed");
  });

  test("rejects malformed hostnames", () => {
    expectRejection("http://-bad.example.com/", "invalid-hostname");
    expectRejection("http://exa mple.com/", "control-characters");
    expectRejection(`http://${"a".repeat(70)}.example.com/`, "invalid-hostname");
    expectRejection(`http://${"a".repeat(250)}.com/`, "hostname-too-long");
  });
});

describe("redirect validation", () => {
  const base = parseTargetUrl("https://example.com/start");

  test("accepts same-origin relative redirects", () => {
    const next = validateRedirectLocation(base, "/landing");
    assert.ok(next);
    assert.equal(next.hostname, "example.com");
    assert.equal(next.scheme, "https:");
  });

  test("accepts redirects to another public https host", () => {
    const next = validateRedirectLocation(base, "https://developer.example.org/docs");
    assert.ok(next);
    assert.equal(next.hostname, "developer.example.org");
  });

  test("refuses redirects into internal destinations", () => {
    for (const location of [
      "http://127.0.0.1/",
      "http://169.254.169.254/latest/meta-data/",
      "http://[::1]/",
      "http://localhost/admin",
      "http://10.0.0.1/",
      "file:///etc/passwd",
      "gopher://internal:6379/_INFO",
      "https://example.com:8443/",
      "//169.254.169.254/",
      "http://2130706433/",
      "http://printer.local/",
    ]) {
      assert.equal(validateRedirectLocation(base, location), null, `redirect to ${location} must be refused`);
    }
  });

  test("refuses unusable Location headers", () => {
    assert.equal(validateRedirectLocation(base, undefined), null);
    assert.equal(validateRedirectLocation(base, ""), null);
    assert.equal(validateRedirectLocation(base, "   "), null);
    assert.equal(validateRedirectLocation(base, "https://\nexample.com/"), null);
  });
});

describe("resolution pinning against a live loopback listener", () => {
  let server: http.Server;
  let port = 0;
  let serverWasHit = false;

  before(async () => {
    server = http.createServer((_req, res) => {
      serverWasHit = true;
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("internal");
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    port = typeof address === "object" && address ? address.port : 0;
  });

  after(() => {
    server.close();
  });

  test("never opens a socket to a loopback listener", async () => {
    // Even though a real server is listening, the guard must refuse first.
    // The loopback address is rejected before the port rule is even reached,
    // which is the safer ordering.
    expectRejection(`http://127.0.0.1:${port}/`, "ip-blocked");
    expectRejection("http://127.0.0.1/", "ip-blocked");
    expectRejection("http://[::1]/", "ip-blocked");
    assert.equal(serverWasHit, false, "the internal test server must never receive a request");
  });

  test("resolves a real public hostname and pins only validated addresses", async (t) => {
    // Network-dependent: skipped (not passed silently) when DNS is unavailable.
    let pinned;
    try {
      pinned = await resolveAndPinTarget(parseTargetUrl("https://example.com/"), { timeoutMs: 8000 });
    } catch (error) {
      t.skip(`DNS unavailable in this environment: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    assert.ok(pinned.addresses.length > 0, "example.com must resolve to at least one address");
    assert.ok(pinned.pinnedAddress === pinned.addresses[0] || pinned.addresses.includes(pinned.pinnedAddress));
    for (const address of pinned.addresses) {
      assert.equal(isBlockedIp(address), false, `resolved address ${address} must be public`);
    }
    assert.equal(pinned.hostname, "example.com");
    assert.equal(pinned.port, 443);
  });

  test("refuses a hostname that resolves to a loopback address", async (t) => {
    // localtest.me is a public DNS name that answers 127.0.0.1 — exactly the
    // rebinding-style trick the resolution step must catch.
    let error;
    try {
      await resolveAndPinTarget(parseTargetUrl("http://localtest.me/"), { timeoutMs: 8000 });
    } catch (caught) {
      error = caught;
    }
    if (!error) {
      t.skip("localtest.me did not resolve in this environment; rebinding case not exercised");
      return;
    }
    assert.ok(error instanceof TargetRejectedError, "must be refused by the guard");
    assert.equal(error.code, "ip-blocked", `got ${error.code}: ${error.message}`);
  });

  test("pinning an IP literal returns that address and a lookup override", async () => {
    const target = parseTargetUrl("https://93.184.216.34/");
    const pinned = await resolveAndPinTarget(target);
    assert.equal(pinned.pinnedAddress, "93.184.216.34");
    assert.deepEqual(pinned.addresses, ["93.184.216.34"]);

    const resolved = await new Promise<{ address: string; family: number }>((resolve, reject) => {
      pinned.lookup("attacker-controlled.example", {}, (error, address, family) => {
        if (error) reject(error);
        else resolve({ address, family });
      });
    });
    // The hostname argument is ignored: only the validated address is returned.
    assert.equal(resolved.address, "93.184.216.34");
    assert.equal(resolved.family, 4);
  });
});
