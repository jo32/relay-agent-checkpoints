import type { Metadata } from "next";
import { headers } from "next/headers";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host =
    requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host");
  const forwardedProtocol = requestHeaders.get("x-forwarded-proto");
  const protocol =
    forwardedProtocol ?? (host?.startsWith("localhost") ? "http" : "https");
  const origin = host ? `${protocol}://${host}` : "http://localhost:3000";
  const socialImage = new URL("/og-security.png", origin).toString();

  return {
    title: {
      default: "Relay — Encrypted checkpoints for agent workspaces.",
      template: "%s · Relay",
    },
    description:
      "Capture, encrypt, and restore AI agent workspaces without exposing source files, workspace context, or recovery keys to Relay.",
    icons: {
      icon: "/favicon.svg",
      shortcut: "/favicon.svg",
    },
    openGraph: {
      title: "Relay — Encrypted checkpoints for agent workspaces.",
      description: "Locally encrypted, zero-knowledge checkpoints with verified restore.",
      type: "website",
      images: [
        {
          url: socialImage,
          width: 1536,
          height: 1024,
          alt: "Relay — locally encrypted checkpoints for agent workspaces",
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title: "Relay — Encrypted checkpoints for agent workspaces.",
      description: "Locally encrypted, zero-knowledge checkpoints with verified restore.",
      images: [socialImage],
    },
  };
}

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable}`}>
      <body className={GeistSans.className}>{children}</body>
    </html>
  );
}
