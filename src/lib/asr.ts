/**
 * Local speech-to-text for Quran recitation via a long-running Python worker.
 *
 * The Python process is spawned once and kept alive. Requests + responses are
 * exchanged as newline-delimited JSON over stdin / stdout. Audio bytes are
 * passed by writing a temporary raw PCM file and sending its path.
 *
 * This avoids ONNX conversion entirely — you can drop in any PyTorch Whisper
 * model from HuggingFace directly.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const MODEL_ID = process.env.HIFZ_ASR_MODEL ?? "tarteel-ai/whisper-base-ar-quran";
const PYTHON_EXE = process.env.HIFZ_PYTHON ?? "python3";

let _python: ReturnType<typeof spawn> | null = null;
let _buffer = "";
let _ready = false;
let _pending = new Map<
  string,
  { resolve: (text: string) => void; reject: (err: Error) => void }
>();
let _reqId = 0;

function startPython() {
  if (_python) return;

  const script = path.join(process.cwd(), "scripts", "asr.py");
  const proc = spawn(PYTHON_EXE, [script, MODEL_ID], {
    stdio: ["pipe", "pipe", "pipe"],
  });

  proc.stderr.on("data", (data: Buffer) => {
    const text = data.toString();
    // Python prints loading progress to stderr; log it so the user sees it.
    if (text.trim()) console.error("[asr.py]", text.trim());
  });

  proc.stdout.on("data", (data: Buffer) => {
    _buffer += data.toString();
    const lines = _buffer.split("\n");
    _buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line) as Record<string, unknown>;
        if (msg.status === "ready") {
          _ready = true;
          console.log("[asr] Python worker ready — model:", msg.model);
          continue;
        }
        const reqId = String(msg._reqId ?? "");
        const pending = _pending.get(reqId);
        if (!pending) continue;
        _pending.delete(reqId);
        if (msg.error) {
          pending.reject(new Error(String(msg.error)));
        } else {
          pending.resolve(String(msg.text ?? ""));
        }
      } catch {
        // Ignore malformed lines (e.g. stray prints).
      }
    }
  });

  proc.on("error", (err) => {
    console.error("[asr] Python process error:", err.message);
    _python = null;
    _ready = false;
    // Fail all pending requests.
    for (const [, p] of _pending) p.reject(new Error("ASR worker crashed"));
    _pending.clear();
  });

  proc.on("close", (code) => {
    console.error("[asr] Python process exited with code", code);
    _python = null;
    _ready = false;
    for (const [, p] of _pending) p.reject(new Error("ASR worker exited"));
    _pending.clear();
  });

  _python = proc;
}

function ensurePython(): ReturnType<typeof spawn> {
  if (!_python || !_ready) {
    startPython();
  }
  return _python!;
}

/** Wait until the Python worker signals it is ready (model loaded). */
async function waitForReady(timeoutMs = 120_000): Promise<void> {
  if (_ready) return;
  startPython();
  const start = Date.now();
  while (!_ready) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("ASR worker failed to become ready — is Python installed with transformers and numpy?");
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

/**
 * Transcribe mono 16 kHz PCM samples to Arabic text.
 * Writes samples to a temp file, asks the Python worker to transcribe it,
 * then cleans up the temp file.
 */
export async function transcribe(samples: Float32Array): Promise<string> {
  await waitForReady();

  const tmpFile = path.join(os.tmpdir(), `hifz-${Date.now()}-${Math.random().toString(36).slice(2)}.raw`);

  // Float32Array may be a view; write only the bytes that belong to the view.
  const byteOffset = samples.byteOffset;
  const byteLength = samples.byteLength;
  const buf = Buffer.from(samples.buffer, byteOffset, byteLength);
  fs.writeFileSync(tmpFile, buf);

  const id = String(++_reqId);
  const proc = ensurePython();

  const promise = new Promise<string>((resolve, reject) => {
    _pending.set(id, { resolve, reject });
  });

  if (!proc.stdin) throw new Error("ASR worker stdin is not available.");
  proc.stdin.write(JSON.stringify({ _reqId: id, audio_path: tmpFile }) + "\n");

  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error("ASR transcription timed out.")), 60_000),
  );

  try {
    const text = await Promise.race([promise, timeout]);
    return text;
  } finally {
    try {
      fs.unlinkSync(tmpFile);
    } catch {
      // Best-effort cleanup.
    }
  }
}

export const activeModelId = MODEL_ID;
