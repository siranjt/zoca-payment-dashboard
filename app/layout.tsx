import "./globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Zoca · Post-Payment Account Reviews",
  description: "Per-customer ICP reviews generated automatically when a Chargebee customer is created.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-slate-50 text-slate-900 min-h-screen">
        <header className="border-b border-slate-200 bg-white">
          <div className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between">
            <div>
              <h1 className="text-xl font-bold text-zoca-ink">Zoca · Post-Payment Reviews</h1>
              <p className="text-xs text-slate-500">ICP fit assessment for every new Discovery customer · auto-generated on Chargebee customer.created</p>
            </div>
            <span className="text-xs uppercase tracking-wide font-bold text-zoca-warn">Confidential</span>
          </div>
        </header>
        <main className="max-w-7xl mx-auto px-6 py-8">{children}</main>
        <footer className="text-xs text-slate-500 text-center py-6 border-t border-slate-200 mt-12">
          Zoca · Confidential — Internal only · Powered by the Payment Validator pipeline
        </footer>
      </body>
    </html>
  );
}
