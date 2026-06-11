#!/usr/bin/env python3
"""
Long-running FastAPI ASR worker for Quranic recitation.

Run with:
    uvicorn scripts.asr_fastapi:app --host 127.0.0.1 --port 8765

The model loads once at startup and stays warm in memory. The Next.js
backend POSTs raw audio bytes (mono 16 kHz float32 little-endian PCM)
to /transcribe and receives {"text": "..."} back. This sits alongside
the stdio NDJSON worker in scripts/asr.py — they do not depend on each
other.

Why a second worker: the stdio path keeps working with the base
tarteel-ai model for low-resource or smoke-test runs. This worker is
the home for the larger MaddoggProduction/whisper-l-v3-turbo-quran-lora
checkpoint, which outputs native tashkeel and needs stride_length_s=2
to keep the 4-layer decoder from entering a repetition loop.
"""

import os
import tempfile
import traceback
import wave

import numpy as np
import torch
from fastapi import FastAPI, HTTPException, Request
from transformers import pipeline

MODEL_ID = os.environ.get(
    "HIFZ_ASR_MODEL",
    "IJyad/whisper-large-v3-Tarteel",
    # "MaddoggProduction/whisper-l-v3-turbo-quran-lora-dataset-mix",
)
SAMPLE_RATE = 16000

# Use MPS on Apple Silicon (M1/M2/M3/M4) when available, otherwise CPU.
# Hard-coding "mps" would crash on Intel/Linux. The current scripts/asr.py
# uses the same conditional — keep them in sync if you change one.
_device = "mps" if torch.backends.mps.is_available() else "cpu"

# Load once — this is the slow part. Subsequent /transcribe calls reuse it.
pipe = pipeline("automatic-speech-recognition", model=MODEL_ID, device=_device)

app = FastAPI(title="Hifz Tester ASR Worker")

# Print the model we're actually running with so it's visible in
# server.log (uvicorn captures stdout) and the operator can confirm
# without having to curl /health. Set HIFZ_ASR_MODEL before starting
# the worker to override.
print(f"[asr_fastapi] model={MODEL_ID} device={_device}", flush=True)


@app.get("/health")
def health() -> dict:
    """Liveness probe. The Next.js client can poll this on startup."""
    return {"status": "ready", "model": MODEL_ID, "device": _device}


def write_wav(path: str, samples: np.ndarray) -> None:
    """Write mono float32 [-1, 1] samples to a 16-bit PCM WAV file.
    Same logic as scripts/asr.py:write_wav — keep them in sync."""
    clipped = np.clip(samples, -1.0, 1.0)
    int16 = (clipped * 32767).astype(np.int16)
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SAMPLE_RATE)
        w.writeframes(int16.tobytes())


@app.post("/transcribe")
async def transcribe(request: Request) -> dict:
    """
    Accept a raw audio body (mono float32 little-endian at 16 kHz) and
    return the transcribed Arabic text. The body is wrapped in a WAV
    container on disk before being fed to the Whisper pipeline, because
    the pipeline infers the format from the file extension and won't
    accept raw bytes (a `.audio` temp file raises "Soundfile is either
    not in the correct format or is malformed"). The stdio worker does
    the same thing in scripts/asr.py.
    """
    body = await request.body()
    if not body:
        return {"text": ""}

    if len(body) % 4 != 0:
        raise HTTPException(
            status_code=400,
            detail=(
                f"Audio body length {len(body)} is not a multiple of 4 bytes; "
                "expected mono float32 PCM at 16 kHz."
            ),
        )

    # Safe temp file — never trust the client's filename, never write
    # into the worker's CWD. Extension is .wav so the pipeline can decode it.
    fd, tmp_path = tempfile.mkstemp(suffix=".wav", prefix="hifz-")
    os.close(fd)
    try:
        samples = np.frombuffer(body, dtype=np.float32)
        write_wav(tmp_path, samples)

        result = pipe(
            tmp_path,
            return_timestamps=False,
            chunk_length_s=30,
            # CRITICAL: the 4-layer turbo decoder loses context and
            # enters infinite repetition loops with longer strides.
            # The MaddoggProduction model card explicitly recommends 2-3s.
            stride_length_s=2,
            batch_size=8,
            generate_kwargs={"task": "transcribe", "language": "arabic", "num_beams": 1},
        )
        text = result["text"] if isinstance(result, dict) else result[0]["text"]
        return {"text": text.strip()}
    except HTTPException:
        raise
    except Exception as e:
        # Log the full traceback to the worker's stderr (uvicorn captures
        # it) so ops can debug. Return a clean 500 with the message so
        # the client sees something more useful than FastAPI's bare
        # "Internal Server Error".
        print(f"[asr_fastapi] /transcribe failed: {e}", flush=True)
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"ASR pipeline error: {e}") from e
    finally:
        try:
            os.remove(tmp_path)
        except OSError:
            # Best-effort cleanup; don't fail the request because of a
            # race with a parallel test or stale /tmp.
            pass
