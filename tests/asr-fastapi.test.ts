/**
 * Tests for the FastAPI ASR worker integration.
 *
 * Two layers of test:
 *   1. Static: read the worker source and the Node client module to make
 *      sure the critical settings (stride, model name, device fallback,
 *      temp-file safety) don't regress. Runs in <1s, no Python needed.
 *   2. Integration (opt-in): if a worker is reachable at
 *      HIFZ_ASR_FASTAPI_URL, POST a synthetic silence WAV and assert
 *      the response shape. Skipped by default to keep `npm test` fast —
 *      the model takes 30-60s to load on a cold start.
 *
 * Run from the project root:  npm test   (uses tsx)
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

const tests: Array<[string, () => void | Promise<void>]> = [];
const test = (name: string, fn: () => void | Promise<void>) => tests.push([name, fn]);

const WORKER_PATH = path.join(process.cwd(), "scripts", "asr_fastapi.py");
const CLIENT_PATH = path.join(process.cwd(), "src", "lib", "asr-fastapi.ts");
const STDIO_WORKER_PATH = path.join(process.cwd(), "scripts", "asr.py");

// --- static: Python worker source ---
test("asr_fastapi.py: references the correct MaddoggProduction model", () => {
  const src = fs.readFileSync(WORKER_PATH, "utf-8");
  assert.match(
    src,
    /MaddoggProduction\/whisper-l-v3-turbo-quran-lora-dataset-mix/,
    "expected the dataset-mix variant of the turbo lora model",
  );
});

test("asr_fastapi.py: stride_length_s is 2 (critical for the 4-layer decoder)", () => {
  const src = fs.readFileSync(WORKER_PATH, "utf-8");
  assert.match(src, /stride_length_s\s*=\s*2/);
});

test("asr_fastapi.py: device falls back to CPU when MPS is unavailable", () => {
  const src = fs.readFileSync(WORKER_PATH, "utf-8");
  assert.match(
    src,
    /torch\.backends\.mps\.is_available\(\)/,
    "expected MPS detection (not a hard-coded device string)",
  );
  assert.match(src, /["']cpu["']/, "expected a CPU fallback");
});

test("asr_fastapi.py: uses tempfile.mkstemp (no CWD writes, no filename injection)", () => {
  const src = fs.readFileSync(WORKER_PATH, "utf-8");
  assert.match(src, /tempfile\.mkstemp/);
  assert.doesNotMatch(src, /f["']temp_\{?file\.filename\}?["']/, "must not use client filename verbatim");
});

test("asr_fastapi.py: temp file uses .wav extension so the pipeline can decode the body", () => {
  // The body is raw float32 PCM; the worker wraps it in a WAV container
  // server-side. The pipeline infers format from the extension and refuses
  // to read .audio (regression that surfaced when the worker only got 500s).
  const src = fs.readFileSync(WORKER_PATH, "utf-8");
  assert.match(src, /mkstemp\([^)]*suffix=["']\.wav["']/, "temp file must end in .wav");
  assert.doesNotMatch(src, /mkstemp\([^)]*suffix=["']\.audio["']/, ".audio extension breaks the pipeline");
});

test("asr_fastapi.py: wraps the raw float32 body in a WAV container (via the wave module)", () => {
  const src = fs.readFileSync(WORKER_PATH, "utf-8");
  assert.match(src, /import wave/);
  assert.match(src, /wave\.open\([^)]*["']wb["']/);
  assert.match(src, /np\.frombuffer\([^)]*dtype=np\.float32/, "must interpret the body as float32");
});

test("asr_fastapi.py: removes the temp file in a finally block", () => {
  const src = fs.readFileSync(WORKER_PATH, "utf-8");
  assert.match(src, /finally:/);
  assert.match(src, /os\.remove\(tmp_path\)/);
});

test("asr_fastapi.py: surfaces pipeline errors as JSON 500, not a bare 'Internal Server Error'", () => {
  const src = fs.readFileSync(WORKER_PATH, "utf-8");
  assert.match(src, /from fastapi import[^)]*HTTPException/);
  assert.match(src, /raise HTTPException\(/);
  // The traceback should be logged for ops, not swallowed.
  assert.match(src, /traceback\.print_exc/);
});

test("asr_fastapi.py: exposes /health for readiness probing", () => {
  const src = fs.readFileSync(WORKER_PATH, "utf-8");
  assert.match(src, /@app\.get\(["']\/health["']\)/);
});

// --- static: stdio worker also updated ---
test("scripts/asr.py: stride_length_s is 2 (not the old 5)", () => {
  const src = fs.readFileSync(STDIO_WORKER_PATH, "utf-8");
  assert.match(src, /stride_length_s\s*=\s*2/);
  assert.doesNotMatch(src, /stride_length_s\s*=\s*5/);
});

// --- static: Node client source ---
test("asr-fastapi.ts: targets loopback HTTP by default", () => {
  const src = fs.readFileSync(CLIENT_PATH, "utf-8");
  assert.match(src, /127\.0\.0\.1/);
  assert.match(src, /HIFZ_ASR_FASTAPI_URL/);
  assert.match(src, /octet-stream/);
  assert.doesNotMatch(src, /socketPath|Unix Domain Socket|--uds/);
});

test("asr-fastapi.ts: has a request timeout", () => {
  const src = fs.readFileSync(CLIENT_PATH, "utf-8");
  assert.match(src, /AbortSignal\.timeout/);
});

// --- integration (opt-in) ---
test("integration: POST synthetic audio to a running worker", async () => {
  const url = process.env.HIFZ_ASR_FASTAPI_URL;
  if (!url) return; // skipped — opt-in only

  const baseUrl = url.replace(/\/transcribe$/, "");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2000);
  let health: Response;
  try {
    health = await fetch(`${baseUrl}/health`, { signal: controller.signal });
  } catch {
    clearTimeout(timeout);
    return; // worker not running, skip
  }
  clearTimeout(timeout);

  if (!health.ok) {
    console.log("  (worker returned non-OK on /health, skipping)");
    return;
  }

  // Build a 1-second mono 16 kHz silence buffer (16000 float32 zeros = 64 KB)
  const silence = new Float32Array(16000);
  const body = Buffer.from(silence.buffer);
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body,
    signal: AbortSignal.timeout(60_000),
  });
  assert.equal(res.status, 200, `worker returned ${res.status}`);
  const data = (await res.json()) as { text?: string };
  assert.equal(typeof data.text, "string", "worker response must include a text field");
});

// --- runner ---
let passed = 0;
(async () => {
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log(`PASS  ${name}`);
      passed++;
    } catch (e) {
      console.log(`FAIL  ${name}`);
      console.error(e instanceof Error ? e.message : e);
    }
  }
  console.log(`\n${passed}/${tests.length} tests passed`);
  process.exit(passed === tests.length ? 0 : 1);
})();
