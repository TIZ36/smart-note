import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "SmartNote Admin",
  description: "Read-only console for SmartNote Cloud workspaces",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-theme="light" suppressHydrationWarning>
      <body>{children}</body>
    </html>
  );
}
