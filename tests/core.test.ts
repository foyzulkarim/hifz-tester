/**
 * Tests for the deterministic core: normalization, alignment, per-ayah grouping.
 * Runs WITHOUT the ASR model -- the part that must be trustworthy is pure logic.
 *
 * Run from the project root:  npm test   (uses tsx)
 */

import assert from "node:assert/strict";
import { normalizeText, tokenize } from "../src/lib/normalize";
import { OpKind, align, hasMistake } from "../src/lib/align";
import { evaluate, luqma } from "../src/lib/session";
import { range } from "../src/lib/quran";

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
