/**
 * Loads the bundled Quran text and turns a selected ayah range into per-ayah
 * reference text plus a flat list of expected tokens, each tagged with the ayah
 * it came from. That provenance lets a flat alignment be reported against the
 * specific ayah + word where a mistake occurred.
 *
 * Server-side only (reads the bundled JSON from disk).
 */

import fs from "node:fs";
import path from "node:path";
import { tokenize } from "./normalize";

export interface Verse {
  surah: number;
  ayah: number;
  text: string; // original (with diacritics), for display
  transliteration: string;
}

export interface ExpectedToken {
  surah: number;
  ayah: number;
  wordIndex: number; // 0-based position within its ayah
  token: string; // normalized
}

interface RawVerse { id: number; text: string; transliteration?: string }
interface RawChapter {
  id: number;
  name: string;
  transliteration: string;
  type: string;
  total_verses: number;
  verses: RawVerse[];
}

const DATA_PATH = path.join(process.cwd(), "data", "quran.json");

let _chapters: Map<number, RawChapter> | null = null;

function chapters(): Map<number, RawChapter> {
  if (!_chapters) {
    const raw = JSON.parse(fs.readFileSync(DATA_PATH, "utf-8")) as RawChapter[];
    _chapters = new Map(raw.map((c) => [c.id, c]));
  }
  return _chapters;
}

export function surahName(surah: number): string {
  const c = chapters().get(surah)!;
  return `${c.transliteration} (${c.name})`;
}

export function totalVerses(surah: number): number {
  return chapters().get(surah)!.total_verses;
}

export function surahList(): Array<{ id: number; label: string; verses: number }> {
  return [...chapters().values()]
    .sort((a, b) => a.id - b.id)
    .map((c) => ({ id: c.id, label: `${c.id}. ${c.transliteration}`, verses: c.total_verses }));
}

export function verse(surah: number, ayah: number): Verse {
  const c = chapters().get(surah)!;
  const v = c.verses[ayah - 1];
  return { surah, ayah, text: v.text, transliteration: v.transliteration ?? "" };
}

export function range(surah: number, fromAyah: number, toAyah: number): Verse[] {
  if (!chapters().has(surah)) throw new Error(`Surah ${surah} does not exist (1-114).`);
  const total = totalVerses(surah);
  if (!(fromAyah >= 1 && fromAyah <= toAyah && toAyah <= total)) {
    throw new Error(
      `Ayah range ${fromAyah}-${toAyah} is invalid for surah ${surah} (it has ${total} ayahs).`,
    );
  }
  const out: Verse[] = [];
  for (let a = fromAyah; a <= toAyah; a++) out.push(verse(surah, a));
  return out;
}

export function expectedTokens(verses: Verse[]): ExpectedToken[] {
  const out: ExpectedToken[] = [];
  for (const v of verses) {
    tokenize(v.text).forEach((token, wordIndex) => {
      out.push({ surah: v.surah, ayah: v.ayah, wordIndex, token });
    });
  }
  return out;
}
