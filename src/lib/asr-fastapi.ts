/**
 * ASR client for the FastAPI worker (scripts/asr_fastapi.py).
 *
 * Sits alongside src/lib/asr.ts (the stdio NDJSON client). Same exported
 * shape so the alignment engine and API routes can swap backends with
 * a one-line change. Both clients target the same model family; the
 * FastAPI path is preferred for the larger MaddoggProduction turbo
 * checkpoint because:
 *   - The worker stays warm across requests (no per-request model load)
 *   - You can probe /health from Node and from curl for ops visibility
 *   - Loopback HTTP is operationally simpler than a UDS or stdio pipe
 *
 * Wire format: raw octet-stream body, identical to what /api/check sends
 * to the stdio worker. The Whisper pipeline accepts a body of bytes via
 * a temp file and figures the format out.
 */

const DEFAULT_URL = "http://192.168.4.28:8765/transcribe";
const TIMEOUT_MS = 60_000;

export async function transcribe(samples: Float32Array): Promise<string> {
  // Read env var at runtime, not build time, so production can override
  // via environment without re-bundling.
  const url = process.env.HIFZ_ASR_FASTAPI_URL ?? DEFAULT_URL;

  // Float32Array may be a view; copy the bytes into a fresh ArrayBuffer-backed
  // Uint8Array so the Blob/BodyInit types are happy. The intermediate copy is
  // a few ms at most for the audio sizes we deal with.
  const copy = new Uint8Array(samples.byteLength);
  copy.set(new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength));
  const body = new Blob([copy], { type: "application/octet-stream" });

  const res = await fetch(url, {
    method: "POST",
    body,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(
      `ASR (fastapi) HTTP ${res.status} from ${url}: ${errText || res.statusText}`,
    );
  }

  const data = (await res.json()) as { text?: string };
  return (data.text ?? "").trim();
}

export const activeBackend = "fastapi" as const;
