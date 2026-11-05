import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "SiteSentra — Website Security Intelligence",
    template: "%s · SiteSentra",
  },
  description:
    "SiteSentra checks the observable HTTPS and HTTP security-header configuration of a public website and reports evidence-backed findings with remediation advice. It is not a penetration test.",
  applicationName: "SiteSentra",
  robots: { index: true, follow: true },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-ink-950 text-mist-200 antialiased">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-signal-400 focus:px-4 focus:py-2 focus:text-sm focus:font-semibold focus:text-ink-950"
        >
          Skip to main content
        </a>
        {children}
      </body>
    </html>
  );
}
