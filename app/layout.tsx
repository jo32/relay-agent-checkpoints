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
  const socialImage = new URL("/og-install-first.png", origin).toString();

  return {
    title: {
      default: "Relay — Install now. Back up when you’re ready.",
      template: "%s · Relay",
    },
    description:
      "Install Relay's checkpoint skills without an account. Sign in only when you're ready to create a private encrypted backup.",
    icons: {
      icon: "/favicon.svg",
      shortcut: "/favicon.svg",
    },
    openGraph: {
      title: "Relay — Install now. Back up when you’re ready.",
      description: "Install the skills without an account. Sign in only for your first encrypted backup.",
      type: "website",
      images: [
        {
          url: socialImage,
          width: 1536,
          height: 1024,
          alt: "Relay — install checkpoint skills now and back up when ready",
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title: "Relay — Install now. Back up when you’re ready.",
      description: "Install the skills without an account. Sign in only for your first encrypted backup.",
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
