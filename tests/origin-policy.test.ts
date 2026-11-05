import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { isSameOriginMutationRequest, isTrustedMutationRequest } from "../src/lib/auth/origin-policy.ts";

const endpoint = "https://app.example.com/api/scans";

function request(headers: Record<string, string> = {}, method = "POST", url = endpoint): Request {
  return new Request(url, { method, headers });
}

describe("same-origin mutation policy", () => {
  test("allows safe methods", () => {
    assert.equal(isSameOriginMutationRequest(request({}, "GET")), true);
    assert.equal(isSameOriginMutationRequest(request({}, "OPTIONS")), true);
  });

  test("accepts an exact matching Origin", () => {
    assert.equal(isSameOriginMutationRequest(request({ origin: "https://app.example.com" })), true);
  });

  test("rejects a sibling subdomain even when it is same-site", () => {
    assert.equal(
      isSameOriginMutationRequest(request({ origin: "https://untrusted.example.com", "sec-fetch-site": "same-site" })),
      false,
    );
  });

  test("rejects scheme and port mismatches", () => {
    assert.equal(isSameOriginMutationRequest(request({ origin: "http://app.example.com" })), false);
    assert.equal(isSameOriginMutationRequest(request({ origin: "https://app.example.com:8443" })), false);
  });

  test("rejects malformed Origin and does not fall back to Fetch Metadata", () => {
    assert.equal(
      isSameOriginMutationRequest(request({ origin: "not a url", "sec-fetch-site": "same-origin" })),
      false,
    );
  });

  test("uses Referer origin when Origin is absent", () => {
    assert.equal(isSameOriginMutationRequest(request({ referer: "https://app.example.com/dashboard" })), true);
    assert.equal(isSameOriginMutationRequest(request({ referer: "https://evil.example/" })), false);
  });

  test("accepts only exact same-origin Fetch Metadata as a fallback", () => {
    assert.equal(isSameOriginMutationRequest(request({ "sec-fetch-site": "same-origin" })), true);
    assert.equal(isSameOriginMutationRequest(request({ "sec-fetch-site": "same-site" })), false);
    assert.equal(isSameOriginMutationRequest(request({ "sec-fetch-site": "cross-site" })), false);
  });

  test("allows non-browser clients with no browser-origin metadata", () => {
    assert.equal(isSameOriginMutationRequest(request()), true);
  });
});

describe("strict policy for cookie-authenticated mutations", () => {
  test("allows safe methods", () => {
    assert.equal(isTrustedMutationRequest(request({}, "GET")), true);
    assert.equal(isTrustedMutationRequest(request({}, "OPTIONS")), true);
  });

  test("accepts an exact matching Origin", () => {
    assert.equal(isTrustedMutationRequest(request({ origin: "https://app.example.com" })), true);
  });

  test("rejects a sibling subdomain even when it is same-site", () => {
    assert.equal(
      isTrustedMutationRequest(request({ origin: "https://untrusted.example.com", "sec-fetch-site": "same-site" })),
      false,
    );
  });

  test("rejects scheme (http vs https) and port mismatches", () => {
    assert.equal(isTrustedMutationRequest(request({ origin: "http://app.example.com" })), false);
    assert.equal(isTrustedMutationRequest(request({ origin: "https://app.example.com:8443" })), false);
    assert.equal(isTrustedMutationRequest(request({ origin: "https://app.example.com:443" })), true);
  });

  test("rejects a malicious origin even when Fetch Metadata lies about same-origin", () => {
    assert.equal(
      isTrustedMutationRequest(request({ origin: "https://evil.example", "sec-fetch-site": "same-origin" })),
      false,
    );
  });

  test("uses Referer origin when Origin is absent", () => {
    assert.equal(isTrustedMutationRequest(request({ referer: "https://app.example.com/dashboard" })), true);
    assert.equal(isTrustedMutationRequest(request({ referer: "https://evil.example/" })), false);
  });

  test("accepts only exact same-origin Fetch Metadata as a fallback", () => {
    assert.equal(isTrustedMutationRequest(request({ "sec-fetch-site": "same-origin" })), true);
    assert.equal(isTrustedMutationRequest(request({ "sec-fetch-site": "same-site" })), false);
    assert.equal(isTrustedMutationRequest(request({ "sec-fetch-site": "cross-site" })), false);
  });

  test("FAILS CLOSED when no origin evidence is present", () => {
    // This is the whole point of the strict variant: a cookie-authenticated
    // mutation with no Origin/Referer/Sec-Fetch-Site cannot be a browser
    // request, so it must not be silently trusted.
    assert.equal(isTrustedMutationRequest(request()), false);
  });

  test("rejects a malformed Origin rather than falling back to Fetch Metadata", () => {
    assert.equal(
      isTrustedMutationRequest(request({ origin: "not a url", "sec-fetch-site": "same-origin" })),
      false,
    );
  });
});
