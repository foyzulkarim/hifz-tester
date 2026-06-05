import { NextResponse } from "next/server";
import { surahList } from "@/lib/quran";

export const runtime = "nodejs";

export function GET() {
  return NextResponse.json(surahList());
}
