import { normalizeText, tokenize } from "./normalize";
import { range as getRange, totalVerses } from "./quran";

export interface DetectRangeResult {
  from: number | null;
  to: number | null;
}

/**
 * Auto-detect the ayah range within a surah by matching the first few words
 * of the transcript against the start of each verse, and the last few words
 * against the end of each verse.
 */
export function detectRange(surah: number, transcript: string): DetectRangeResult {
  const total = totalVerses(surah);
  const verses = getRange(surah, 1, total);
  const transcriptTokens = tokenize(transcript);

  if (transcriptTokens.length === 0) {
    return { from: null, to: null };
  }

  // --- start detection ---
  let from: number | null = null;
  // Try exact prefix match first (most users start at the beginning of an ayah)
  for (let prefixLen = 5; prefixLen >= 2; prefixLen--) {
    if (transcriptTokens.length < prefixLen) continue;
    const prefix = transcriptTokens.slice(0, prefixLen).join(" ");
    for (const v of verses) {
      const normalizedVerse = normalizeText(v.text);
      if (normalizedVerse.startsWith(prefix)) {
        from = v.ayah;
        break;
      }
    }
    if (from !== null) break;
  }
  // Fallback: sliding window (user might start mid-ayah, e.g. after a luqma)
  if (from === null) {
    for (let prefixLen = 5; prefixLen >= 2; prefixLen--) {
      if (transcriptTokens.length < prefixLen) continue;
      const prefix = transcriptTokens.slice(0, prefixLen).join(" ");
      for (const v of verses) {
        const normalizedVerse = normalizeText(v.text);
        if (normalizedVerse.includes(prefix)) {
          from = v.ayah;
          break;
        }
      }
      if (from !== null) break;
    }
  }

  // --- end detection ---
  // The end must be at or after the start (if known), so we restrict the
  // search to verses from `from` onwards. If `from` is not found, we still
  // prefer the last matching verse to avoid picking an earlier repetition.
  const candidateVerses = from !== null
    ? verses.filter((v) => v.ayah >= from)
    : verses;
  let to: number | null = null;
  // Try exact suffix match first, preferring the last match (iterate backwards)
  for (let suffixLen = 5; suffixLen >= 2; suffixLen--) {
    if (transcriptTokens.length < suffixLen) continue;
    const suffix = transcriptTokens.slice(-suffixLen).join(" ");
    for (let i = candidateVerses.length - 1; i >= 0; i--) {
      const normalizedVerse = normalizeText(candidateVerses[i].text);
      if (normalizedVerse.endsWith(suffix)) {
        to = candidateVerses[i].ayah;
        break;
      }
    }
    if (to !== null) break;
  }
  // Fallback: sliding window, preferring the last match
  if (to === null) {
    for (let suffixLen = 5; suffixLen >= 2; suffixLen--) {
      if (transcriptTokens.length < suffixLen) continue;
      const suffix = transcriptTokens.slice(-suffixLen).join(" ");
      for (let i = candidateVerses.length - 1; i >= 0; i--) {
        const normalizedVerse = normalizeText(candidateVerses[i].text);
        if (normalizedVerse.includes(suffix)) {
          to = candidateVerses[i].ayah;
          break;
        }
      }
      if (to !== null) break;
    }
  }

  return { from, to };
}
