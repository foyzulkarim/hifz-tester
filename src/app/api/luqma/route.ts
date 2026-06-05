import { NextRequest, NextResponse } from "next/server";
import { luqma } from "@/lib/session";

export const runtime = "nodejs";

/** GET /api/luqma?surah=1&ayah=2&word=1&count=1  (word is 1-based) */
export function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const surah = Number(sp.get("surah"));
  const ayah = Number(sp.get("ayah"));
  const word = Number(sp.get("word") ?? "1");
  const count = Number(sp.get("count") ?? "1");
  if (!surah || !ayah) {
    return NextResponse.json({ error: "Missing surah/ayah." }, { status: 400 });
  }
  try {
    const text = luqma(surah, ayah, Math.max(0, word - 1), count);
    return NextResponse.json({ text });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 400 },
    );
  }
}
