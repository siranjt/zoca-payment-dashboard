import "./globals.css";
import Link from "next/link";
import type { Metadata } from "next";
import ZocaLogo from "@/components/ZocaLogo";

export const metadata: Metadata = {
  title: "Zoca · Post-Payment Reviews",
  description:
    "Per-customer ICP reviews generated automatically when a Chargebee customer is created.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>
        <div className="min-h-screen flex flex-col">
          <header className="px-4 sm:px-8 py-5 sm:py-7 print:hidden">
            <div className="max-w-7xl mx-auto flex items-center justify-between gap-4">
              <Link href="/" className="flex items-center gap-4 group flex-shrink-0">
                <ZocaLogo width={108} height={27} />
                <span className="hidden md:inline-block w-px h-5 bg-line"></span>
                <span className="text-sm text-ink-muted group-hover:text-ink transition hidden md:inline">
                  Post-Payment Reviews
                </span>
              </Link>
              <nav className="flex items-center gap-3 sm:gap-5 text-xs sm:text-sm text-ink-muted">
                <span className="hidden lg:inline">Live · Chargebee + Metabase + Claude</span>
                <span className="text-ink-dim hidden lg:inline">·</span>
                <a
                  href="https://zoca.chargebee.com/"
                  target="_blank"
                  rel="noreferrer"
                  className="hover:text-ink transition whitespace-nowrap"
                >
                  Open Chargebee ↗
                </a>
              </nav>
            </div>
          </header>
          <main className="flex-1">
            <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pb-16">{children}</div>
          </main>
          <footer className="border-t border-line-soft py-6 mt-8 print:hidden">
            <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 text-xs text-ink-dim">
              Internal tool. Verdicts must be reviewed by an account manager before action is taken
              on the customer.
            </div>
          </footer>
        </div>
      </body>
    </html>
  );
}
