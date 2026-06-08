/**
 * Tests for the deterministic core: normalization, alignment, per-ayah grouping.
 * Runs WITHOUT the ASR model -- the part that must be trustworthy is pure logic.
 *
 * Run from the project root:  npm test   (uses tsx)
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { normalizeText, tokenize } from "../src/lib/normalize";
import { OpKind, align, hasMistake } from "../src/lib/align";
import { evaluate, luqma } from "../src/lib/session";
import { range, surahList, verse } from "../src/lib/quran";
import { sanitizeTranslit } from "../src/lib/transliteration";

const tests: Array<[string, () => void]> = [];
const test = (name: string, fn: () => void) => tests.push([name, fn]);

// --- normalization ---
test("diacritics are stripped", () => {
  assert.equal(normalizeText("بِسۡمِ ٱللَّهِ"), normalizeText("بسم الله"));
});
test("alef variants fold together", () => {
  assert.equal(normalizeText("أحمد"), normalizeText("احمد"));
  assert.equal(normalizeText("إيمان"), normalizeText("ايمان"));
});
test("tokenize drops empties", () => {
  assert.deepEqual(tokenize("  الله   الرحمن  "), ["الله", "الرحمن"]);
});

// --- alignment: the four verdicts ---
test("clean match", () => {
  const exp = ["الحمد", "لله", "رب", "العالمين"];
  const ops = align(exp, [...exp]);
  assert.ok(!hasMistake(ops));
});
test("substitution is pinpointed", () => {
  const exp = ["الحمد", "لله", "رب", "العالمين"];
  const ops = align(exp, ["الحمد", "لله", "رب", "الناس"]);
  const subs = ops.filter((o) => o.kind === OpKind.SUBSTITUTION);
  assert.equal(subs.length, 1);
  assert.equal(subs[0].refIndex, 3);
  assert.equal(subs[0].expected, "العالمين");
  assert.equal(subs[0].heard, "الناس");
});
test("omission is pinpointed", () => {
  const ops = align(["مالك", "يوم", "الدين"], ["مالك", "الدين"]);
  const om = ops.filter((o) => o.kind === OpKind.OMISSION);
  assert.equal(om.length, 1);
  assert.equal(om[0].expected, "يوم");
  assert.equal(om[0].refIndex, 1);
});
test("insertion is flagged", () => {
  const ops = align(["اياك", "نعبد"], ["اياك", "حقا", "نعبد"]);
  const ins = ops.filter((o) => o.kind === OpKind.INSERTION);
  assert.equal(ins.length, 1);
  assert.equal(ins[0].heard, "حقا");
});
test("ASR near-miss is tolerated", () => {
  const ops = align(["العالمين"], ["العالمون"]); // ~0.875 similar
  assert.ok(!hasMistake(ops), "near-miss should be absorbed as a match");
});

// --- transliteration sanitizer ---
test("sanitizeTranslit keeps plain text unchanged", () => {
  assert.equal(sanitizeTranslit("Bismi Allah"), "Bismi Allah");
});
test("sanitizeTranslit maps <u>X</u> and <u>X</U> to <span class=\"tajweed-em\">X</span>", () => {
  assert.equal(sanitizeTranslit("<u>a</u>"), '<span class="tajweed-em">a</span>');
  assert.equal(sanitizeTranslit("<u>a</U>"), '<span class="tajweed-em">a</span>');
});
test("sanitizeTranslit maps <b>X</b> and <b>X</B> to <span class=\"tajweed-heavy\">X</span>", () => {
  assert.equal(sanitizeTranslit("<b>a</b>"), '<span class="tajweed-heavy">a</span>');
  assert.equal(sanitizeTranslit("<b>a</B>"), '<span class="tajweed-heavy">a</span>');
});
test("sanitizeTranslit handles <i> and <strong>", () => {
  assert.equal(sanitizeTranslit("<i>a</i>"), '<span class="tajweed-i">a</span>');
  assert.equal(sanitizeTranslit("<strong>a</strong>"), '<span class="tajweed-strong">a</span>');
});
test("sanitizeTranslit strips orphan </b>, </B>, </U> closes", () => {
  assert.equal(sanitizeTranslit("a</b>b</B>c</U>"), "abc");
});
test("sanitizeTranslit strips unknown tags (e.g. <script>, <img onerror=…>)", () => {
  assert.equal(sanitizeTranslit("a<script>b</script>c"), "abc");
  assert.equal(sanitizeTranslit('a<img onerror="x">b'), "ab");
});
test("sanitizeTranslit strips tags with attributes", () => {
  assert.equal(sanitizeTranslit('a<u class="x">b</u>c'), "abc");
});
test("sanitizeTranslit drops an unclosed <u> (no close in the input)", () => {
  assert.equal(sanitizeTranslit("a<u>b"), "ab");
});

// --- quran-enhanced loader ---
test("surahList exposes meaning and revelationType for every surah", () => {
  const list = surahList();
  assert.equal(list.length, 114);
  for (const s of list) {
    assert.ok(s.meaning && s.meaning.length > 0, `surah ${s.id} missing meaning`);
    assert.ok(
      s.revelationType === "Meccan" || s.revelationType === "Medinan",
      `surah ${s.id} has invalid revelationType`,
    );
  }
});
test("surahList preserves the existing {id, label, verses} shape for the dropdown", () => {
  const list = surahList();
  for (const s of list) {
    assert.equal(typeof s.id, "number");
    assert.equal(typeof s.label, "string");
    assert.equal(typeof s.verses, "number");
    assert.ok(s.label.includes(String(s.id)));
  }
});
test("verse() returns translation and transliteration for a known ayah", () => {
  const v = verse(1, 1);
  assert.equal(v.surah, 1);
  assert.equal(v.ayah, 1);
  assert.ok(v.text.length > 0);
  assert.ok(v.translation && v.translation.length > 0, "missing translation");
  assert.ok(v.transliteration && v.transliteration.length > 0, "missing transliteration");
  // Transliteration should be sanitized (no raw <u>/<b> left)
  assert.ok(!v.transliteration.includes("<u>"), "transliteration contains raw <u>");
  assert.ok(!v.transliteration.includes("<b>"), "transliteration contains raw <b>");
});

// --- end-to-end over real bundled data (Al-Fatihah) ---
test("session clean on perfect recitation", () => {
  const verses = range(1, 1, 7);
  const perfect = verses.map((v) => v.text).join(" ");
  const report = evaluate(1, 1, 7, perfect);
  assert.ok(report.allClean, report.summary);
});
test("session pinpoints mistake in the correct ayah", () => {
  const verses = range(1, 1, 7);
  const spoken: Record<number, string> = {};
  for (const v of verses) spoken[v.ayah] = v.text;
  const words = spoken[5].split(/\s+/);
  words[1] = "نَشۡكُرُ"; // swap نعبد -> نشكر (positional, diacritics-safe)
  spoken[5] = words.join(" ");
  const transcript = [1, 2, 3, 4, 5, 6, 7].map((a) => spoken[a]).join(" ");

  const report = evaluate(1, 1, 7, transcript);
  assert.ok(!report.allClean);
  const bad = report.ayahs.filter((a) => !a.clean);
  assert.equal(bad.length, 1);
  assert.equal(bad[0].ayah, 5);
  assert.ok(bad[0].notes.some((n) => n.kind === OpKind.SUBSTITUTION));
});
test("luqma returns the next word", () => {
  const w = luqma(1, 2, 0, 1);
  assert.ok(w.length > 0 && !w.includes(" "));
});

// --- ASR worker regression: the 4-layer turbo decoder (the model used in
// scripts/asr_fastapi.py, and the stdio worker when HIFZ_ASR_MODEL is set to
// a turbo variant) loses context and enters infinite repetition loops when
// the stride is too long. The MaddoggProduction model card recommends 2-3s.
// Pin both worker files at 2 so a stray bump back to 5 fails CI.
test("scripts/asr.py uses stride_length_s=2 to prevent turbo repetition loops", () => {
  const src = fs.readFileSync(path.join(process.cwd(), "scripts", "asr.py"), "utf-8");
  assert.match(src, /stride_length_s\s*=\s*2/);
});
test("scripts/asr_fastapi.py uses stride_length_s=2 to prevent turbo repetition loops", () => {
  const src = fs.readFileSync(path.join(process.cwd(), "scripts", "asr_fastapi.py"), "utf-8");
  assert.match(src, /stride_length_s\s*=\s*2/);
});

// --- runner ---
let passed = 0;
for (const [name, fn] of tests) {
  try {
    fn();
    console.log(`PASS  ${name}`);
    passed++;
  } catch (e) {
    console.log(`FAIL  ${name}`);
    console.error(e instanceof Error ? e.message : e);
  }
}
console.log(`\n${passed}/${tests.length} tests passed`);
process.exit(passed === tests.length ? 0 : 1);
