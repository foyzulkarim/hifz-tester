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
 *
 * Uses node:http directly to bypass Next.js's production fetch patching,
 * which was returning EHOSTUNREACH for LAN IPs in the service context.
 */

import http from "node:http";

const DEFAULT_URL = "http://127.0.0.1:8765/transcribe";
const TIMEOUT_MS = 60_000;

export async function transcribe(samples: Float32Array): Promise<string> {
  // Read env var at runtime so production can override without re-bundling.
  const url = process.env.HIFZ_ASR_FASTAPI_URL ?? DEFAULT_URL;

  const copy = new Uint8Array(samples.byteLength);
  copy.set(new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength));

  const parsed = new URL(url);

  return new Promise<string>((resolve, reject) => {
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: Number(parsed.port) || 80,
        path: parsed.pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Length": copy.byteLength,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          if (res.statusCode !== 200) {
            reject(new Error(`ASR (fastapi) HTTP ${res.statusCode} from ${url}: ${body}`));
            return;
          }
          try {
            const data = JSON.parse(body) as { text?: string };
            resolve((data.text ?? "").trim());
          } catch {
            reject(new Error(`ASR (fastapi) invalid JSON from ${url}: ${body}`));
          }
        });
      },
    );

    req.setTimeout(TIMEOUT_MS, () => {
      req.destroy(new Error(`ASR (fastapi) timeout after ${TIMEOUT_MS}ms from ${url}`));
    });

    req.on("error", reject);
    req.write(copy);
    req.end();
  });
}

export const activeBackend = "fastapi" as const;
