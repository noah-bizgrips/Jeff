import { NextResponse } from "next/server";

export async function GET() {
  return NextResponse.json(
    {
      app: "Jeff",
      status: "ok",
      stage: "vercel-starter",
      liveDataConnected: false,
    },
    {
      headers: {
        "Cache-Control": "no-store",
      },
    },
  );
}
