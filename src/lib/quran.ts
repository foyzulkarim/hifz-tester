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
import { sanitizeTranslit } from "./transliteration";

export interface Verse {
  surah: number;
  ayah: number;
  text: string; // original (with diacritics), for display
  transliteration: string;
  translation?: string;
}

export interface ExpectedToken {
  surah: number;
  ayah: number;
  wordIndex: number; // 0-based position within its ayah
  token: string; // normalized
}

interface RawVerse {
  number: number;
  arabic: string;
  translations: Record<string, string>;
}

interface RawChapter {
  id: number;
  name: string;
  nameArabic: string;
  meaning: string;
  verseCount: number;
  revelationType: string;
  verses: RawVerse[];
}

interface QuranData {
  meta: unknown;
  surahs: RawChapter[];
}

const DATA_PATH = path.join(process.cwd(), "data", "quran-enhanced.json");

let _chapters: Map<number, RawChapter> | null = null;

function chapters(): Map<number, RawChapter> {
  if (!_chapters) {
    const raw = JSON.parse(fs.readFileSync(DATA_PATH, "utf-8")) as QuranData;
    _chapters = new Map(raw.surahs.map((c) => [c.id, c]));
  }
  return _chapters;
}

let _verseCache: Map<string, Verse> | null = null;

function verseCache(): Map<string, Verse> {
  if (!_verseCache) {
    _verseCache = new Map();
    for (const [surahId, chapter] of chapters()) {
      for (const v of chapter.verses) {
        const key = `${surahId}:${v.number}`;
        const rawTranslit = v.translations["en.transliteration"] ?? "";
        _verseCache.set(key, {
          surah: surahId,
          ayah: v.number,
          text: v.arabic,
          transliteration: sanitizeTranslit(rawTranslit),
          translation: v.translations["en.sahih"] ?? undefined,
        });
      }
    }
  }
  return _verseCache;
}

export function totalVerses(surah: number): number {
  return chapters().get(surah)!.verseCount;
}

export function surahList(): Array<{
  id: number;
  label: string;
  verses: number;
  name: string;
  meaning: string;
  revelationType: string;
  nameArabic: string;
}> {
  return [...chapters().values()]
    .sort((a, b) => a.id - b.id)
    .map((c) => ({
      id: c.id,
      label: `${c.id}. ${c.name}`,
      verses: c.verseCount,
      name: c.name,
      meaning: c.meaning,
      revelationType: c.revelationType,
      nameArabic: c.nameArabic,
    }));
}

export function verse(surah: number, ayah: number): Verse {
  const key = `${surah}:${ayah}`;
  const cached = verseCache().get(key);
  if (!cached) {
    const c = chapters().get(surah)!;
    const v = c.verses[ayah - 1];
    const rawTranslit = v.translations["en.transliteration"] ?? "";
    return {
      surah,
      ayah,
      text: v.arabic,
      transliteration: sanitizeTranslit(rawTranslit),
      translation: v.translations["en.sahih"] ?? undefined,
    };
  }
  return cached;
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
