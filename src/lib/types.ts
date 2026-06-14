import type { OpKind } from "./align";

export interface AyahNote {
  kind: OpKind;
  wordIndex: number | null; // 0-based within the ayah
  expected: string | null;
  heard: string | null;
}

export interface AyahResult {
  surah: number;
  ayah: number;
  text: string; // original, for display
  clean: boolean;
  notes: AyahNote[];
  heardText?: string; // ASR tokens attributed to this ayah
  translation?: string;
  transliteration?: string;
}

export interface NextWordHint {
  surah: number;
  ayah: number;
  wordIndex: number;
  text: string;
  transliteration?: string;
}

export interface SessionReport {
  surah: number;
  fromAyah: number;
  toAyah: number;
  transcript: string;
  allClean: boolean;
  summary: string;
  ayahs: AyahResult[];
  nextWord: NextWordHint | null;
}

export interface SurahInfo {
  id: number;
  label: string;
  verses: number;
  name?: string;
  meaning?: string;
  revelationType?: "Meccan" | "Medinan";
  nameArabic?: string;
}
