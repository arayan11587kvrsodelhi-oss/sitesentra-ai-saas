import { IconChevronDown } from "@/components/icons";
import { EmptyState } from "@/components/ui";

type Hop = {
  probe: "requested" | "https" | "http";
  url: string;
  scheme: string;
  statusCode: number | null;
  responseTimeMs: number;
  headers: Record<string, string[]>;
  cookies: string[];
  tls: {
    protocol: string | null;
    cipher: string | null;
    authorized: boolean;
    authorizationError: string | null;
    subjectCN?: string | null;
    issuerCN?: string | null;
    validTo?: string | null;
  } | null;
  error: { code: string; message: string } | null;
};

const PROBE_LABEL: Record<Hop["probe"], string> = {
  requested: "requested",
  https: "https probe",
  http: "http probe",
};

function statusTone(code: number | null) {
  if (code === null) return "text-critical";
  if (code >= 200 && code < 300) return "text-pass";
  if (code >= 300 && code < 400) return "text-low";
  return "text-medium";
}

/**
 * The raw observation transcript: every hop, in order, with the headers exactly
 * as received (Set-Cookie values were already redacted before storage). Kept as
 * a collapsible monospace document — it is evidence, so it is complete.
 */
export function Transcript({ hops }: { hops: Hop[] }) {
  if (hops.length === 0) {
    return (
      <EmptyState
        title="No requests were sent"
        description="The target was refused by the safety policy before any socket was opened. Nothing was observed, so there is no transcript."
      />
    );
  }

  return (
    <ol className="divide-y divide-line">
      {hops.map((hop, index) => {
        const headerCount = Object.keys(hop.headers).length;
        return (
          <li key={`${hop.url}-${index}`}>
            <details className="disclosure group" open={index === 0}>
              <summary className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-3 transition-colors hover:bg-hover/60 sm:px-5">
                <span className="mono w-5 shrink-0 text-[11px] text-faint tabular-nums">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <span className="mono rounded-full border border-line bg-inset px-2 py-0.5 text-[9.5px] tracking-[0.06em] text-muted uppercase">
                  {PROBE_LABEL[hop.probe] ?? hop.probe}
                </span>
                <span className={`mono text-[12px] font-medium tabular-nums ${statusTone(hop.statusCode)}`}>
                  {hop.statusCode ?? hop.error?.code ?? "no response"}
                </span>
                <span className="mono min-w-0 flex-1 basis-40 truncate text-[12px] text-soft" title={hop.url}>
                  {hop.url}
                </span>
                <span className="mono shrink-0 text-[11px] text-faint tabular-nums">{hop.responseTimeMs} ms</span>
                <IconChevronDown size={14} className="chev shrink-0 text-faint" />
              </summary>

              <div className="border-t border-line bg-base/60 px-4 py-3 sm:px-5">
                <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
                  <Detail label="Scheme" value={hop.scheme} />
                  <Detail label="Status" value={hop.statusCode === null ? "no response" : String(hop.statusCode)} />
                  {hop.tls ? (
                    <>
                      <Detail label="TLS protocol" value={hop.tls.protocol ?? "—"} />
                      <Detail label="Cipher" value={hop.tls.cipher ?? "—"} />
                      <Detail
                        label="Hostname verified"
                        value={hop.tls.authorized ? "yes" : `no (${hop.tls.authorizationError ?? "unknown"})`}
                      />
                      <Detail label="Certificate CN / issuer" value={`${hop.tls.subjectCN ?? "—"} / ${hop.tls.issuerCN ?? "—"}`} />
                    </>
                  ) : null}
                </dl>

                {hop.error ? (
                  <p className="mono mt-3 rounded-sm border border-critical/30 bg-critical/[0.06] px-2.5 py-1.5 text-[11.5px] text-critical">
                    {hop.error.code}: {hop.error.message}
                  </p>
                ) : null}

                <div className="mt-3">
                  <p className="mono mb-1.5 text-[10.5px] tracking-[0.08em] text-faint uppercase">
                    Response headers · {headerCount}
                  </p>
                  {headerCount > 0 ? (
                    <pre className="well evidence-value m-0 max-h-72 overflow-auto rounded-xl px-3 py-2.5">
                      {Object.entries(hop.headers)
                        .map(([name, values]) => `${name}: ${values.join(", ")}`)
                        .join("\n")}
                    </pre>
                  ) : (
                    <p className="mono text-[11.5px] text-muted">No response headers were received.</p>
                  )}
                </div>

                {hop.cookies.length > 0 ? (
                  <div className="mt-3">
                    <p className="mono mb-1.5 text-[10.5px] tracking-[0.08em] text-faint uppercase">
                      Cookies observed · values redacted
                    </p>
                    <ul className="space-y-1">
                      {hop.cookies.map((cookie, cookieIndex) => (
                        <li key={`${cookie}-${cookieIndex}`} className="mono text-[11.5px] leading-5 text-soft">
                          {cookie}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </div>
            </details>
          </li>
        );
      })}
    </ol>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-line/70 py-1 last:border-b-0 sm:border-b-0 sm:py-0">
      <dt className="mono text-[10.5px] tracking-[0.06em] text-faint uppercase">{label}</dt>
      <dd className="mono min-w-0 truncate text-right text-[11.5px] text-soft" title={value}>
        {value}
      </dd>
    </div>
  );
}
