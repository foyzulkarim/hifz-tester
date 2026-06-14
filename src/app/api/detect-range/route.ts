import { NextRequest, NextResponse } from "next/server";
import { detectRange } from "@/lib/detect-range";

export const runtime = "nodejs";

/**
 * POST /api/detect-range
 * Body: JSON { surah, transcript }
 * Returns: { from: number | null, to: number | null }
 *
 * Auto-detects the ayah range within a surah by matching the first few words
 * of the transcript against the start of each verse, and the last few words
 * against the end of each verse. Uses the same normalization as the alignment
 * engine so comparisons are fair.
 */
export async function POST(req: NextRequest) {
  let body: { surah?: number; transcript?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const { surah, transcript } = body;
  if (!surah || typeof transcript !== "string" || transcript.trim().length === 0) {
    return NextResponse.json({ error: "Missing surah or transcript." }, { status: 400 });
  }

  try {
    const result = detectRange(surah, transcript);
    return NextResponse.json(result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}
