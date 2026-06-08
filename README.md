# Hifz Tester

A local, single-user tool that plays the role of the listening teacher in hifz:
you recite a chosen range of ayahs, it transcribes you on the server, and it
tells you — at the level of the individual word — whether you recited correctly
or exactly where you slipped. Next.js + TypeScript, server-side ASR, nothing
leaves your machine at inference time.

This is an MVP focused on one thing done well: **word-level correctness with
precise pinpointing.** It does not grade tajweed, and it works in
record-then-review mode (recite the whole range, then get feedback), not live
interruption.

---

## How it works

```
  browser: record mic ─▶ decode + resample to 16 kHz mono ─▶ POST /api/check
                                                                   │
   server: Whisper (Quran-fine-tuned, Python via FastAPI on 127.0.0.1) ─▶ text
                                                                   │
           reference ayah text ─▶ normalize ◀── normalize ◀───────┘
                                      │
                                    align  (deterministic, tolerant)
                                      │
                            per-ayah verdict + pinpointed word ─▶ JSON ─▶ UI
```

Two ASR backends ship side by side:

- **`/api/check`** — long-running Python worker (`scripts/asr.py`) communicating
  with Node over stdin/stdout NDJSON. The default. Lowest deps: just `python3`
  with `transformers` and `torch`.
- **`/api/check-fast`** — long-running FastAPI worker (`scripts/asr_fastapi.py`)
  bound to `http://127.0.0.1:8765`. Same model default, same wire format on the
  client (raw octet-stream). Use this if you want `curl` for debugging, want
  to swap models without restarting the Next.js dev server, or want to run
  multiple Next.js processes against one warm model.

Both backends use the same model by default (`HIFZ_ASR_MODEL`). Both pin
`stride_length_s=2`, which is critical for the 4-layer turbo decoder — longer
strides cause infinite repetition loops during silence.

The load-bearing decision: **the verdict is decided in code, never by an LLM.**
The reference text is known, so this is a *verification* problem. A deterministic
word-level alignment against the known text gives a reproducible, inspectable
answer — the same recitation always yields the same verdict. Two layers keep it
honest: **normalization** (`src/lib/normalize.ts`) folds diacritics and
orthographic variants so they can't masquerade as mistakes, and **tolerant
alignment** (`src/lib/align.ts`) absorbs a close ASR near-miss as the recognizer
fumbling a *correct* word rather than flagging you.

---

## Requirements

- Node.js 18.18+ (20+ recommended)
- A microphone, used from the browser
- Internet on first run only — to fetch npm packages and (once) the ASR model

## Install & run

```bash
cd hifz-tester
npm install
npm run dev
```

Open http://localhost:3000. Pick a surah and ayah range, record your recitation,
press **Check recitation**. Use the **Show next word (luqma)** panel when you
stall, and the **Tuning** panel to adjust match tolerance.

> On a Linux box with an NVIDIA GPU (e.g. your RTX 3060 machine), the
> `onnxruntime-node` install may try to fetch a CUDA binary. If that stalls,
> install with `npm install --onnxruntime-node-install-cuda=skip`. On macOS this
> isn't needed — it uses CPU execution.

---

## Run as a background service (macOS)

If you want the app to keep running after you close the terminal and auto-start
on boot, use the LaunchAgent. It runs the **production build** (not dev mode):

```bash
# Build first (re-run after any code change)
npm run build

# Start the service
launchctl load ~/Library/LaunchAgents/com.foyzul.hifz-tester.plist

# Stop the service
launchctl unload ~/Library/LaunchAgents/com.foyzul.hifz-tester.plist

# Check if running
launchctl list | grep com.foyzul.hifz-tester

# View logs
tail -f ~/personal/hafiz-ai/hifz-tester/server.log
```

---

## Getting real quality: the ASR model

The default model is `tarteel-ai/whisper-base-ar-quran` (a Quran-fine-tuned
Whisper) for the stdio worker, and `MaddoggProduction/whisper-l-v3-turbo-quran-lora-dataset-mix`
for the FastAPI worker. Both auto-download on first run; both keep warm in
memory after that. Both pin `stride_length_s=2` to keep the 4-layer turbo
decoder from entering a repetition loop during silence.

Override with `HIFZ_ASR_MODEL`:

```bash
HIFZ_ASR_MODEL="IJyad/whisper-large-v3-Tarteel" npm run dev
```

Candidate checkpoints (fastest → most accurate):
- `tarteel-ai/whisper-base-ar-quran` — small, fast, decent on clean recitation
- `MaddoggProduction/whisper-l-v3-turbo-quran-lora-dataset-mix` — large encoder, 4-layer turbo decoder, **outputs native tashkeel**, balanced
- `IJyad/whisper-large-v3-Tarteel` — full large-v3, max quality, slowest

> **First run downloads the model.** For the dataset-mix variant that's about
> 1.5 GB on disk and 30-60s to load into MPS on Apple Silicon. Subsequent
> restarts reuse the HF cache.

### Running the FastAPI worker

`npm run dev` starts both Next.js and the FastAPI worker in parallel (via
`concurrently`). The stdio worker (`scripts/asr.py`) only needs `transformers`
+ `torch` + `numpy`. The FastAPI worker additionally needs `fastapi` and
`uvicorn`:

```bash
pip install fastapi uvicorn transformers torch numpy
```

(If you only use the stdio worker you can skip `fastapi` and `uvicorn`.)

If you'd rather start the two processes by hand:

```bash
# Terminal 1 — FastAPI worker (defaults to 127.0.0.1:8765)
npm run asr:start

# Terminal 2 — Next.js dev server only
npm run dev:next-only
```

The FastAPI worker exposes a readiness probe at `http://127.0.0.1:8765/health`.
If you want to swap to a UDS transport later, the change is local to
`scripts/asr_fastapi.py` (add `uvicorn` `--uds` flag) and
`src/lib/asr-fastapi.ts` (swap the `fetch` for `http.request({ socketPath })`).

### Environment variables

| Var | Default | Used by |
|---|---|---|
| `HIFZ_ASR_MODEL` | `tarteel-ai/whisper-base-ar-quran` (stdio) / `MaddoggProduction/whisper-l-v3-turbo-quran-lora-dataset-mix` (fastapi) | both workers |
| `HIFZ_PYTHON` | `python3` | stdio worker (`scripts/asr.py`) |
| `HIFZ_ASR_FASTAPI_URL` | `http://127.0.0.1:8765/transcribe` | fastapi worker (`scripts/asr_fastapi.py`) |

---

## The one knob you will actually tune

Match tolerance lives in two places: the **Tuning** slider in the UI (per-session)
and `SIMILARITY_THRESHOLD` in `src/lib/align.ts` (the default, `0.80`).

- Flagging words you recited correctly (false alarms)? **Lower** it.
- Letting real mistakes slip through? **Raise** it.

This can only be dialed in against *your* voice and *your* model's output. Record
a few ranges you know cold and adjust. That's expected iteration, not a defect.

## Tests

The trustworthy core is fully tested without the model or any audio:

```bash
npm test
```

Verifies diacritic folding, near-miss tolerance, and that substitutions,
omissions, and insertions are pinpointed to the correct ayah and word — end to
end over the real Al-Fatihah text. (11 tests.)

---

## Honest limitations

- **The ASR path was written but not run against real audio during development**
  (no mic/model in the build environment). The deterministic core *is* tested.
  Treat first use as validation.
- **First run downloads the model** (generic fallback, or your converted one).
- **Word-level only** — it checks which words you recited, not tajweed.
- **Batch, not live** — recite the full range, then review. Real-time
  interruption and automatic luqma are a future step needing a streaming pipeline.
- **ASR false positives are the main risk** — the normalization + tolerance
  layers and the threshold knob manage this; a specialised model + tuning are
  what make it usable.
- **Scope:** Hafs an Asim; plain-script reference (diacritics ignored for matching).

## Project layout

```
hifz-tester/
├── data/quran-enhanced.json     # bundled Quran text (114 surahs) — offline
├── scripts/
│   ├── asr.py                   # stdio NDJSON worker (default backend for /api/check)
│   └── asr_fastapi.py           # FastAPI worker (backend for /api/check-fast, default for `npm run dev`)
├── src/
│   ├── lib/
│   │   ├── normalize.ts         # Arabic normalization (both sides of compare)
│   │   ├── align.ts             # tolerant word-level alignment + the verdict
│   │   ├── quran.ts             # text loading, range selection, provenance
│   │   ├── session.ts           # orchestration -> per-ayah report
│   │   ├── asr.ts               # stdio NDJSON client (calls scripts/asr.py)
│   │   ├── asr-fastapi.ts       # HTTP client (calls scripts/asr_fastapi.py)
│   │   ├── transliteration.ts   # sanitizer for the per-verse transliteration HTML
│   │   └── types.ts             # shared report types (client + server)
│   └── app/
│       ├── page.tsx             # the UI (recording, feedback, luqma, tuning)
│       ├── layout.tsx, globals.css
│       └── api/{surahs,check,check-fast,luqma}/route.ts
└── tests/
    ├── core.test.ts             # core logic + Quran loader + transliteration sanitizer
    └── asr-fastapi.test.ts      # ASR worker source checks + opt-in integration
```

> Quran source moved to `quran-enhanced.json` (quran-simple edition + per-ayah Saheeh translation + per-ayah transliteration).

## Where to take it next

- **Live mode:** stream audio, track position in real time, interrupt at the
  mistake, auto-prompt the next word on a pause.
- **Warmer feedback:** feed the structured per-ayah report to a local LLM for
  phrasing only — keep the verdict in code.
- **In-browser ASR:** transformers.js can also run client-side via WebGPU for a
  zero-backend, fully-offline variant (practical for smaller models).
