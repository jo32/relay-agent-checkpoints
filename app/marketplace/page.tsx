import type { Metadata } from "next";
import { headers } from "next/headers";
import MarketplaceClient from "./marketplace-client";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host =
    requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host");
  const forwardedProtocol = requestHeaders.get("x-forwarded-proto");
  const protocol =
    forwardedProtocol ?? (host?.startsWith("localhost") ? "http" : "https");
  const origin = host ? `${protocol}://${host}` : "http://localhost:3000";
  const socialImage = new URL("/og-marketplace.png", origin).toString();
  const title = "Public checkpoint marketplace";
  const description =
    "Search, discover, and restore intentionally public Relay workspace checkpoints.";

  return {
    title,
    description,
    openGraph: {
      title: `${title} · Relay`,
      description,
      type: "website",
      images: [
        {
          url: socialImage,
          width: 1536,
          height: 1024,
          alt: "Relay public checkpoint marketplace",
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title: `${title} · Relay`,
      description,
      images: [socialImage],
    },
  };
}

export const dynamic = "force-dynamic";

export default async function MarketplacePage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; sort?: string }>;
}) {
  const params = await searchParams;
  const initialQuery = typeof params.q === "string" ? params.q.slice(0, 160) : "";
  const initialSort = params.sort === "latest" ? "latest" : "recommended";

  return (
    <MarketplaceClient initialQuery={initialQuery} initialSort={initialSort} />
  );
}
