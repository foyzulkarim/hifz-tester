/**
 * Local speech-to-text for Quran recitation, server-side via Transformers.js
 * (ONNX Runtime). Nothing leaves the machine at inference time.
 *
 * QUALITY PATH (recommended): a Quran-fine-tuned Whisper converted to ONNX once,
 * placed under ./models and pointed to by HIFZ_ASR_MODEL. A *general* Whisper is
 * the wrong tool -- it is trained on conversational Arabic and will manufacture
 * false mistakes on melodic tajweed. See the README for the one-time conversion.
 *
 * OUT-OF-THE-BOX: if HIFZ_ASR_MODEL is unset, we fall back to a generic Whisper
 * ONNX that auto-downloads, so the full loop runs immediately for plumbing tests
 * -- but expect lower accuracy until you swap in the converted Quran model.
 */

import path from "node:path";
import { env, pipeline } from "@huggingface/transformers";

// Allow loading a locally-converted model from ./models, and cache downloads.
env.allowLocalModels = true;
env.localModelPath = path.join(process.cwd(), "models");
env.cacheDir = path.join(process.cwd(), ".model-cache");

// Default is a generic, definitely-available ONNX Whisper so the app boots with
// zero setup. Set HIFZ_ASR_MODEL to your converted Quran model for real quality.
const MODEL_ID = process.env.HIFZ_ASR_MODEL ?? "Xenova/whisper-base";

type ASROutput = { text?: string } | Array<{ text?: string }>;
type ASRPipeline = (audio: Float32Array, opts?: Record<string, unknown>) => Promise<ASROutput>;
let _pipe: Promise<ASRPipeline> | null = null;

function getPipe(): Promise<ASRPipeline> {
  if (!_pipe) {
    _pipe = pipeline("automatic-speech-recognition", MODEL_ID) as unknown as Promise<ASRPipeline>;
  }
  return _pipe;
}

/**
 * Transcribe mono 16 kHz PCM samples to Arabic text.
 * The browser is responsible for decoding + resampling to 16 kHz mono.
 */
export async function transcribe(samples: Float32Array): Promise<string> {
  const transcriber = await getPipe();
  const result = await transcriber(samples, {
    language: "arabic",
    task: "transcribe",
    chunk_length_s: 20, // keep modest; long strides can trip turbo models
    stride_length_s: 3,
    return_timestamps: false,
  });
  const text = Array.isArray(result)
    ? result.map((r) => (r as { text?: string }).text ?? "").join(" ")
    : ((result as { text?: string }).text ?? "");
  return text.trim();
}

export const activeModelId = MODEL_ID;
