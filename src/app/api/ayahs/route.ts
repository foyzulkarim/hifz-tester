import { NextRequest, NextResponse } from "next/server";
import { range } from "@/lib/quran";

export const runtime = "nodejs";

/**
 * GET /api/ayahs?surah=1&from=1&to=7
 * Returns: Array<{ ayah, text, translation?, transliteration }> -- the actual
 * Quran text for the selected range, so the UI can show the reference verses
 * (what SHOULD be recited, as opposed to the ASR transcript of what WAS).
 */
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const surah = Number(sp.get("surah"));
  const from = Number(sp.get("from"));
  const to = Number(sp.get("to"));

  if (!surah || !from || !to) {
    return NextResponse.json({ error: "Missing surah/from/to." }, { status: 400 });
  }

  try {
    const verses = range(surah, from, to).map((v) => ({
      ayah: v.ayah,
      text: v.text,
      translation: v.translation,
      transliteration: v.transliteration,
    }));
    return NextResponse.json(verses);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}
