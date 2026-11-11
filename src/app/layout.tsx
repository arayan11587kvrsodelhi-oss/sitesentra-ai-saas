import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";

/*
 * Self-hosted at build time by next/font, which keeps the app's CSP
 * (`font-src 'self' data:`) valid — no third-party font requests at runtime.
 */
const inter = Inter({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-inter",
});

const jetbrains = JetBrains_Mono({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-jetbrains",
});

export const viewport: Viewport = {
  themeColor: "#010606",
  colorScheme: "dark",
};

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
    <html lang="en" className={`${inter.variable} ${jetbrains.variable}`}>
      <body>
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[70] focus:rounded-full focus:bg-mint focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-[#02241f]"
        >
          Skip to main content
        </a>
        {children}
      </body>
    </html>
  );
}
