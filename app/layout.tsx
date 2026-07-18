import type { Metadata } from "next";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "Relay — Portable agent checkpoints",
    template: "%s · Relay",
  },
  description:
    "Pause here. Continue anywhere. Relay stores safe, portable workspace checkpoints created and restored by agent skills.",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
  openGraph: {
    title: "Relay — Pause here. Continue anywhere.",
    description:
      "Sanitized, immutable workspace checkpoints created and restored by agent skills.",
    type: "website",
  },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable}`}>
      <body className={GeistSans.className}>{children}</body>
    </html>
  );
}
