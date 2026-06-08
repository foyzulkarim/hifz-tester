/**
 * Session orchestration -- glue between the deterministic engine and the API.
 *
 *   range -> expected tokens (with provenance)
 *   transcript -> normalized tokens
 *   align -> positioned edit operations
 *   group by ayah -> per-ayah verdict + pinpointed mistakes + plain-English notes
 *
 * No LLM decides correctness. The English notes are a faithful, templated
 * rendering of the deterministic diff. If you later want a warmer teacher voice,
 * feed THIS structured report to a local LLM for phrasing only.
 *
 * The report is plain JSON so it crosses the API boundary unchanged.
 */

import { Op, OpKind, align } from "./align";
import { normalizeToken, tokenize } from "./normalize";
import { ExpectedToken, Verse, expectedTokens, range, verse } from "./quran";
import type { AyahNote, AyahResult, NextWordHint, SessionReport } from "./types";

export type { AyahNote, AyahResult, NextWordHint, SessionReport } from "./types";

function noteFrom(op: Op, wordIndex: number | null): AyahNote {
  return { kind: op.kind, wordIndex, expected: op.expected, heard: op.heard };
}

/**
 * Map normalized heard words back to their original transcript form (with harakat).
 * alignment works on stripped tokens; the UI should show the diacritized words
 * the ASR actually emitted so non-Arabic readers can pronounce them.
 */
function restoreHeardWords(ops: Op[], transcript: string): Op[] {
  const originalWords = transcript.trim().split(/\s+/).filter((w) => w.length > 0);
  const normalizedWords = originalWords.map((w) => normalizeToken(w));
  const used = new Set<number>();

  return ops.map((op) => {
    if (!op.heard) return op;
    const idx = normalizedWords.findIndex((n, i) => n === op.heard && !used.has(i));
    if (idx >= 0) {
      used.add(idx);
      return { ...op, heard: originalWords[idx] };
    }
    return op;
  });
}

export function evaluate(
  surah: number,
  fromAyah: number,
  toAyah: number,
  transcript: string,
  similarityThreshold?: number,
): SessionReport {
  const verses = range(surah, fromAyah, toAyah);
  const expected = expectedTokens(verses);
  const heard = tokenize(transcript);

  const ops = restoreHeardWords(
    align(
      expected.map((e) => e.token),
      heard,
      similarityThreshold,
    ),
    transcript,
  );

  const ayahs = groupByAyah(verses, expected, ops);
  const allClean = ayahs.every((a) => a.clean);
  const badCount = ayahs.filter((a) => !a.clean).length;
  const summary = allClean
    ? "Lesson complete — every ayah in range was clean. Proceed to the next chunk."
    : `${badCount} of ${ayahs.length} ayah(s) need another look.`;
  const nextWord = computeNextWord(verses, expected, ops);

  return { surah, fromAyah, toAyah, transcript: transcript.trim(), allClean, summary, ayahs, nextWord };
}

function computeNextWord(
  verses: Verse[],
  expected: ExpectedToken[],
  ops: Op[],
): NextWordHint | null {
  let maxRefIndex = -1;
  for (const op of ops) {
    // Only count words the user actually SAID (match or substitution).
    // An omission means they never got to that word, so we should
    // suggest it as the next word, not skip past it.
    if (op.heard !== null && op.refIndex !== null && op.refIndex > maxRefIndex) {
      maxRefIndex = op.refIndex;
    }
  }
  const nextIdx = maxRefIndex + 1;
  if (nextIdx >= expected.length) return null; // genuinely finished the range

  const et = expected[nextIdx];
  const verseObj = verses.find((v) => v.surah === et.surah && v.ayah === et.ayah);
  const words = verseObj ? verseObj.text.trim().split(/\s+/) : [];
  return {
    surah: et.surah,
    ayah: et.ayah,
    wordIndex: et.wordIndex,
    text: words[et.wordIndex] ?? "",
    transliteration: verseObj?.transliteration,
  };
}

function groupByAyah(
  verses: Verse[],
  expected: ExpectedToken[],
  ops: Op[],
): AyahResult[] {
  const order = verses.map((v) => `${v.surah}:${v.ayah}`);
  const byKey = new Map<string, AyahResult>(
    verses.map((v) => [
      `${v.surah}:${v.ayah}`,
      {
        surah: v.surah,
        ayah: v.ayah,
        text: v.text,
        clean: true,
        notes: [],
        translation: v.translation,
        transliteration: v.transliteration,
      },
    ]),
  );

  let lastKey = order[0];
  for (const op of ops) {
    if (op.refIndex !== null) {
      const et = expected[op.refIndex];
      lastKey = `${et.surah}:${et.ayah}`;
      if (op.kind !== OpKind.MATCH) {
        const ar = byKey.get(lastKey)!;
        ar.clean = false;
        ar.notes.push(noteFrom(op, et.wordIndex));
      }
    } else {
      // insertion: attach to the ayah of the preceding reference token
      const ar = byKey.get(lastKey)!;
      ar.clean = false;
      ar.notes.push(noteFrom(op, null));
    }
  }
  return order.map((k) => byKey.get(k)!);
}

/**
 * Luqma (manual hint): the next `count` word(s) of an ayah, as plain text.
 * Pure lookup against the known reference -- no audio, no model.
 */
export function luqma(surah: number, ayah: number, wordIndex = 0, count = 1): string {
  const words = verse(surah, ayah).text.split(/\s+/);
  return words.slice(wordIndex, wordIndex + count).join(" ");
}
