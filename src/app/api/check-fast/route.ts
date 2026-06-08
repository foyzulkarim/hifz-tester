import { NextRequest, NextResponse } from "next/server";
import { transcribe } from "@/lib/asr-fastapi";
import { evaluate } from "@/lib/session";

export const runtime = "nodejs";
export const maxDuration = 120; // ASR on a large model can take a while

/**
 * POST /api/check-fast?surah=1&from=1&to=7[&threshold=0.8]
 * Body: raw bytes of a Float32Array -- mono PCM at 16 kHz (decoded client-side).
 * Returns: SessionReport JSON.
 *
 * Sibling of /api/check; uses the FastAPI worker (scripts/asr_fastapi.py)
 * running on http://127.0.0.1:8765 instead of the stdio NDJSON worker in
 * scripts/asr.py. Wire format and report shape are identical so the
 * client can swap routes without changes.
 *
 * Pre-flight: make sure the FastAPI worker is up:
 *   uvicorn scripts.asr_fastapi:app --host 127.0.0.1 --port 8765
 * or use `npm run dev` (the script in package.json runs both processes).
 */
export async function POST(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const surah = Number(sp.get("surah"));
  const from = Number(sp.get("from"));
  const to = Number(sp.get("to"));
  const threshold = sp.get("threshold") ? Number(sp.get("threshold")) : undefined;

  if (!surah || !from || !to) {
    return NextResponse.json({ error: "Missing surah/from/to." }, { status: 400 });
  }
  if (from > to) {
    return NextResponse.json({ error: "From-ayah is after To-ayah." }, { status: 400 });
  }

  const buf = await req.arrayBuffer();
  if (buf.byteLength === 0) {
    return NextResponse.json({ error: "No audio received." }, { status: 400 });
  }
  const samples = new Float32Array(buf);

  let transcript: string;
  try {
    transcript = await transcribe(samples);
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

  try {
    const report = evaluate(surah, from, to, transcript, threshold);
    return NextResponse.json(report);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}
