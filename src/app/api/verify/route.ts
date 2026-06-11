import { NextRequest, NextResponse } from "next/server";
import { evaluate } from "@/lib/session";

export const runtime = "nodejs";

/**
 * POST /api/verify
 * Body: JSON { surah, from, to, transcript, threshold? }
 * Returns: SessionReport JSON (same shape as /api/check).
 *
 * Verify-only half of the old /api/check-fast: pure text-vs-text alignment
 * of an already-transcribed recitation against a Quran range. No audio, no
 * model -- cheap enough to re-run on every range or threshold change.
 */
export async function POST(req: NextRequest) {
  let body: {
    surah?: number;
    from?: number;
    to?: number;
    transcript?: string;
    threshold?: number;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const { surah, from, to, transcript, threshold } = body;
  if (!surah || !from || !to) {
    return NextResponse.json({ error: "Missing surah/from/to." }, { status: 400 });
  }
  if (from > to) {
    return NextResponse.json({ error: "From-ayah is after To-ayah." }, { status: 400 });
  }
  if (typeof transcript !== "string" || transcript.trim().length === 0) {
    return NextResponse.json({ error: "Missing transcript." }, { status: 400 });
  }

  try {
    const report = evaluate(surah, from, to, transcript, threshold);
    return NextResponse.json(report);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}
