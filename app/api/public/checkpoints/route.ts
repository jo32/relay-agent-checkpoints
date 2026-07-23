import { NextResponse } from "next/server";
import {
  listMarketplaceCheckpoints,
  type MarketplaceSort,
} from "@/db/checkpoints";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const query = url.searchParams.get("q") ?? "";
  const sort: MarketplaceSort =
    url.searchParams.get("sort") === "latest" ? "latest" : "recommended";
  const page = boundedInteger(url.searchParams.get("page"), 1, 10_000, 1);
  const pageSize = boundedInteger(url.searchParams.get("limit"), 1, 48, 24);

  try {
    const listing = await listMarketplaceCheckpoints({
      query,
      sort,
      page,
      pageSize,
    });
    const recommendations =
      sort === "recommended" && page === 1
        ? listing.checkpoints.slice(0, 3)
        : (
            await listMarketplaceCheckpoints({
              query,
              sort: "recommended",
              page: 1,
              pageSize: 3,
            })
          ).checkpoints;

    return NextResponse.json(
      {
        ...listing,
        recommendations,
      },
      {
        headers: {
          "cache-control": "public, max-age=60, stale-while-revalidate=300",
        },
      },
    );
  } catch (error) {
    console.error("Unable to list the public checkpoint marketplace", error);
    return NextResponse.json(
      { error: "The public checkpoint marketplace is temporarily unavailable." },
      { status: 503 },
    );
  }
}

function boundedInteger(
  value: string | null,
  minimum: number,
  maximum: number,
  fallback: number,
) {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(minimum, Math.min(maximum, parsed));
}
