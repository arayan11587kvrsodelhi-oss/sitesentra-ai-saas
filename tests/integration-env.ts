/**
 * SiteSentra — integration test environment resolution.
 *
 * SINGLE SOURCE OF TRUTH for which database integration tests may touch.
 *
 * Rules enforced here:
 *  - The URL comes ONLY from `DATABASE_URL_INTEGRATION`. There is no fallback
 *    to `DATABASE_URL`, `.env` or `.env.local`. Tests must never inherit the
 *    application's production connection just because it happens to be set.
 *  - Production database protection:
 *      * Rejects when `DATABASE_URL_INTEGRATION` matches `DATABASE_URL` by raw string.
 *      * If `DATABASE_URL` is present but unparseable or not a postgres URL, aborts fail-closed.
 *      * Rejects when `DATABASE_URL_INTEGRATION` matches `DATABASE_URL` by parsed
 *        Neon endpoint ID and database name (guarding against pooled vs unpooled host
 *        variants or differing credentials targeting the same production database).
 *  - Run ID format is strictly validated (^ss-itest-[0-9]{13}-[a-f0-9]{8}$).
 *  - Endpoint parsing is strictly restricted to legitimate Neon hostnames (*.neon.tech).
 *  - Absence of any required value is a hard failure, never a skip.
 */
import { randomBytes } from "node:crypto";

export type IntegrationTarget = {
  /** Connection string the app and the test pool must both use. */
  url: string;
  /** Exact Neon endpoint id, e.g. `ep-solitary-brook-ao2y8jbj`. */
  expectedEndpointId: string;
  /** Exact database name, e.g. `sitesentra_integration`. */
  expectedDatabaseName: string;
  /** Exact branch name the operator provisioned for tests, e.g. `sitesentra-integration-test`. */
  expectedBranchName: string;
};

export class IntegrationConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IntegrationConfigError";
  }
}

/** Strict run ID regex: ss-itest-<13-digit-timestamp>-<8-hex-chars> */
export const RUN_ID_PATTERN = /^ss-itest-\d{13}-[a-f0-9]{8}$/;

export function validateRunId(id: string): boolean {
  return RUN_ID_PATTERN.test(id);
}

export function generateRunId(): string {
  const timestamp = Date.now().toString().padStart(13, "0");
  const randomPart = randomBytes(4).toString("hex");
  return `ss-itest-${timestamp}-${randomPart}`;
}

/** Next.js strips surrounding quotes from env values; mirror that exactly. */
export function normaliseEnvValue(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function required(name: string): string {
  const value = normaliseEnvValue(process.env[name]);
  if (!value) {
    throw new IntegrationConfigError(
      `${name} is required for integration tests. Refusing to run: no fallback to DATABASE_URL or .env files is permitted.`,
    );
  }
  return value;
}

/**
 * Neon endpoint id extracted from a connection string.
 *
 * Neon hosts look like `ep-<id>-pooler.<region>.aws.neon.tech` or `ep-<id>.<region>.aws.neon.tech`.
 * The hostname must legitimately end in `.neon.tech` to prevent spoofing via third-party domains.
 */
export function endpointIdFromUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new IntegrationConfigError("Connection string is not a parseable URL.");
  }

  const hostname = parsed.hostname.toLowerCase();
  if (!hostname.endsWith(".neon.tech")) {
    return null;
  }

  const labels = hostname.split(".");
  const firstLabel = labels[0];
  if (!firstLabel || !firstLabel.startsWith("ep-")) {
    return null;
  }

  const endpoint = firstLabel.endsWith("-pooler")
    ? firstLabel.slice(0, -"-pooler".length)
    : firstLabel;

  if (!/^ep-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(endpoint)) {
    return null;
  }

  return endpoint;
}

export function databaseNameFromUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    const name = parsed.pathname.replace(/^\/+/, "");
    return name.length > 0 ? name : null;
  } catch {
    return null;
  }
}

/**
 * Resolve and validate the integration target.
 *
 * @throws IntegrationConfigError when anything is missing, self-conflicting, or targeting production.
 */
export function resolveIntegrationTarget(): IntegrationTarget {
  const url = required("DATABASE_URL_INTEGRATION");
  const expectedEndpointId = required("INTEGRATION_EXPECTED_ENDPOINT_ID").toLowerCase();
  const expectedDatabaseName = required("INTEGRATION_EXPECTED_DATABASE_NAME");
  const expectedBranchName = required("INTEGRATION_EXPECTED_BRANCH");

  if (!/^postgres(ql)?:\/\//i.test(url)) {
    throw new IntegrationConfigError("DATABASE_URL_INTEGRATION must be a postgres:// or postgresql:// URL.");
  }

  const actualEndpoint = endpointIdFromUrl(url);
  if (!actualEndpoint) {
    throw new IntegrationConfigError(
      "Could not extract a valid Neon endpoint id (ep-…) ending in .neon.tech from DATABASE_URL_INTEGRATION. Identity cannot be verified, so the run is aborted.",
    );
  }

  const actualDatabase = databaseNameFromUrl(url);
  if (!actualDatabase) {
    throw new IntegrationConfigError("DATABASE_URL_INTEGRATION does not name a database.");
  }

  // Production database protection:
  const appUrl = normaliseEnvValue(process.env.DATABASE_URL);
  if (appUrl) {
    if (appUrl === url) {
      throw new IntegrationConfigError(
        "DATABASE_URL_INTEGRATION is identical to DATABASE_URL. Refusing to run integration tests against the application database.",
      );
    }

    let parsedAppUrl: URL;
    try {
      parsedAppUrl = new URL(appUrl);
    } catch {
      throw new IntegrationConfigError(
        "DATABASE_URL is present but is not a parseable URL. Production target cannot be safely evaluated; aborting.",
      );
    }

    if (!/^postgres(ql)?:$/i.test(parsedAppUrl.protocol)) {
      throw new IntegrationConfigError(
        "DATABASE_URL is present but is not a valid postgres:// or postgresql:// URL. Production target cannot be safely evaluated; aborting.",
      );
    }

    const appEndpoint = endpointIdFromUrl(appUrl);
    const appDatabase = databaseNameFromUrl(appUrl);
    if (
      appEndpoint &&
      appDatabase &&
      actualEndpoint === appEndpoint &&
      actualDatabase === appDatabase
    ) {
      throw new IntegrationConfigError(
        `DATABASE_URL_INTEGRATION targets the same Neon endpoint ('${actualEndpoint}') and database ('${actualDatabase}') as DATABASE_URL. Refusing to run integration tests against the application database.`,
      );
    }
  }

  return {
    url,
    expectedEndpointId,
    expectedDatabaseName,
    expectedBranchName,
  };
}
