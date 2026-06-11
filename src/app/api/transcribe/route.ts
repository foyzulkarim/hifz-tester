import { NextRequest, NextResponse } from "next/server";
import { transcribe } from "@/lib/asr-fastapi";

export const runtime = "nodejs";
export const maxDuration = 120; // ASR on a large model can take a while

/**
 * POST /api/transcribe
 * Body: raw bytes of a Float32Array -- mono PCM at 16 kHz (decoded client-side).
 * Returns: { transcript } JSON.
 *
 * Transcribe-only half of the old /api/check-fast: runs ASR with no Quran
 * range attached, so the client can transcribe right after recording and
 * verify later (against any range) via /api/verify without re-running ASR.
 */
export async function POST(req: NextRequest) {
  const buf = await req.arrayBuffer();
  if (buf.byteLength === 0) {
    return NextResponse.json({ error: "No audio received." }, { status: 400 });
  }
  const samples = new Float32Array(buf);

  try {
    const transcript = await transcribe(samples);
    return NextResponse.json({ transcript });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      {
        error:
          "Transcription failed. Is the FastAPI ASR worker running on " +
          "http://127.0.0.1:8765? Start it with `uvicorn scripts.asr_fastapi:app " +
          "--host 127.0.0.1 --port 8765` or use `npm run dev`. Details: " +
          msg,
      },
      { status: 500 },
    );
  }
}
