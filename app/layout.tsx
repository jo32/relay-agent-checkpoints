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
      default: "Relay — Private or public checkpoints for agent workspaces.",
      template: "%s · Relay",
    },
    description:
      "Keep agent workspace checkpoints locally encrypted, or intentionally publish a sanitized artifact for stable, keyless restore.",
    icons: {
      icon: "/favicon.svg",
      shortcut: "/favicon.svg",
    },
    openGraph: {
      title: "Relay — Private or public checkpoints for agent workspaces.",
      description: "Private ciphertext by default, intentionally readable public artifacts when you choose.",
      type: "website",
      images: [
        {
          url: socialImage,
          width: 1536,
          height: 1024,
          alt: "Relay — private or public checkpoints for agent workspaces",
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title: "Relay — Private or public checkpoints for agent workspaces.",
      description: "Private ciphertext by default, intentionally readable public artifacts when you choose.",
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
