#!/usr/bin/env python3
"""
Long-running ASR worker invoked by Node.js via stdin/stdout IPC.
Load the model once at startup, then transcribe on demand.

Protocol: newline-delimited JSON (NDJSON)
  Node -> Python: {"audio_path": "/tmp/hifz-123.raw"}
  Python -> Node: {"text": "..."}  or  {"error": "..."}
"""

import json
import os
import struct
import sys
import wave

import numpy as np
import torch
from transformers import pipeline

MODEL_ID = sys.argv[1] if len(sys.argv) > 1 else "tarteel-ai/whisper-base-ar-quran"

# Prefer CUDA (Linux/NVIDIA), then MPS (Apple Silicon), then CPU.
_device = (
    "cuda" if torch.cuda.is_available()
    else "mps" if torch.backends.mps.is_available()
    else "cpu"
)

# Load once — this is the slow part.
asr = pipeline("automatic-speech-recognition", model=MODEL_ID, device=_device)

# Some fine-tuned Whisper models are missing the timestamp token in their
# generation config. Patch it so the pipeline does not crash.
if (
    hasattr(asr.model, "generation_config")
    and asr.model.generation_config is not None
    and not hasattr(asr.model.generation_config, "no_timestamps_token_id")
):
    asr.model.generation_config.no_timestamps_token_id = 50362

# Signal ready so Node knows it is safe to start sending work.
print(json.dumps({"status": "ready", "model": MODEL_ID}), flush=True)


def write_wav(path: str, samples: np.ndarray, sr: int = 16000) -> None:
    """Write mono float32 [-1, 1] samples to a 16-bit PCM WAV file."""
    # Clip to [-1, 1] then convert to int16
    clipped = np.clip(samples, -1.0, 1.0)
    int16 = (clipped * 32767).astype(np.int16)
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(int16.tobytes())


for line in sys.stdin:
    line = line.strip()
    if not line:
        continue

    try:
        req = json.loads(line)
        audio_path = req.get("audio_path")
        req_id = req.get("_reqId")
        if not audio_path:
            raise ValueError("missing audio_path")

        samples = np.fromfile(audio_path, dtype=np.float32)
        wav_path = audio_path + ".wav"
        try:
            write_wav(wav_path, samples)
            result = asr(
                wav_path,
                return_timestamps=False,
                chunk_length_s=30,
                # CRITICAL for the 4-layer turbo decoder (whisper-l-v3-turbo): keep
                # stride at 2-3s. Longer strides cause the decoder to lose context
                # and enter infinite repetition loops during silence. See the
                # MaddoggProduction model card.
                stride_length_s=2,
            )
            text = result["text"] if isinstance(result, dict) else result[0]["text"]
            resp = {"_reqId": req_id, "text": text.strip()}
        finally:
            # Best-effort cleanup; an exception during asr() must not leave
            # the WAV behind in /tmp. The Node side cleans up the .raw file
            # independently.
            try:
                os.unlink(wav_path)
            except OSError:
                pass
    except Exception as e:
        resp = {"_reqId": req.get("_reqId"), "error": str(e)}

    print(json.dumps(resp), flush=True)
