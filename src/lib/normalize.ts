/**
 * Arabic / Quranic text normalization.
 *
 * Both the reference ayah text AND the ASR transcript are pushed through the
 * exact same normalization before comparison, so that surviving differences are
 * *meaningful* differences and not orthographic noise.
 *
 * MVP choice: compare WITHOUT diacritics (tashkeel). The ASR rarely emits them
 * consistently and the Uthmani source is full of annotation marks the recognizer
 * never produces. We check word-level spelling correctness, not tajweed.
 */

// Harakat / tanwin / shadda / sukun and the superscript (dagger) alef U+0670.
const TASHKEEL = new Set(
  [
    0x0610, 0x0611, 0x0612, 0x0613, 0x0614, 0x0615, 0x0616, 0x0617, 0x0618,
    0x0619, 0x061a, 0x064b, 0x064c, 0x064d, 0x064e, 0x064f, 0x0650, 0x0651,
    0x0652, 0x0653, 0x0654, 0x0655, 0x0656, 0x0657, 0x0658, 0x0659, 0x065a,
    0x065b, 0x065c, 0x065d, 0x065e, 0x065f, 0x0670,
  ].map((c) => String.fromCodePoint(c)),
);

// Quranic annotation / pause / sajdah marks present in Uthmani text (U+06D6..U+06ED).
const QURANIC_MARKS = new Set(
  Array.from({ length: 0x06ed - 0x06d6 + 1 }, (_, i) =>
    String.fromCodePoint(0x06d6 + i),
  ),
);

const TATWEEL = "\u0640"; // kashida

const STRIP = new Set<string>([...TASHKEEL, ...QURANIC_MARKS, TATWEEL]);

// Fold orthographic variants the ASR and different mushaf editions treat alike.
const LETTER_MAP: Record<string, string> = {
  "\u0622": "\u0627", // آ -> ا
  "\u0623": "\u0627", // أ -> ا
  "\u0625": "\u0627", // إ -> ا
  "\u0671": "\u0627", // ٱ wasla -> ا
  "\u0649": "\u064a", // ى -> ي
  "\u0629": "\u0647", // ة -> ه
  "\u0624": "\u0648", // ؤ -> و
  "\u0626": "\u064a", // ئ -> ي
};

const DROP = new Set<string>(["\u0621"]); // bare hamza ء

// Keep only Arabic-block letters after folding.
const isArabicLetter = (ch: string): boolean => {
  const cp = ch.codePointAt(0)!;
  return cp >= 0x0600 && cp <= 0x06ff;
};

export function normalizeToken(token: string): string {
  const nfc = token.normalize("NFC");
  let out = "";
  for (const ch of nfc) {
    if (STRIP.has(ch) || DROP.has(ch)) continue;
    out += LETTER_MAP[ch] ?? ch;
  }
  return Array.from(out).filter(isArabicLetter).join("");
}

export function normalizeText(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (!collapsed) return "";
  return collapsed
    .split(" ")
    .map(normalizeToken)
    .filter((t) => t.length > 0)
    .join(" ");
}

export function tokenize(text: string): string[] {
  const norm = normalizeText(text);
  return norm ? norm.split(" ") : [];
}
