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
   server: Whisper (Quran-fine-tuned, ONNX/transformers.js) ─▶ Arabic text
                                                                   │
           reference ayah text ─▶ normalize ◀── normalize ◀───────┘
                                      │
                                    align  (deterministic, tolerant)
                                      │
                            per-ayah verdict + pinpointed word ─▶ JSON ─▶ UI
```

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

Out of the box, `HIFZ_ASR_MODEL` is unset and the app falls back to a **generic**
Whisper (`Xenova/whisper-base`) that auto-downloads, so the full loop runs
immediately for testing. A generic model is trained on conversational Arabic and
will manufacture false mistakes on melodic recitation — fine for verifying the
plumbing, not for real use.

For quality, convert a **Quran-fine-tuned** Whisper to ONNX once and point the app
at it:

```bash
# one-time conversion (Python, run anywhere — produces an ONNX model folder)
git clone https://github.com/huggingface/transformers.js
cd transformers.js
pip install -r scripts/requirements.txt
python -m scripts.convert --quantize --model_id IJyad/whisper-large-v3-Tarteel
```

This writes the converted model under `models/IJyad/whisper-large-v3-Tarteel/`.
Copy that folder into this project's `models/` directory, then run with the env
var set to the folder name (the app resolves it under `./models`):

```bash
HIFZ_ASR_MODEL="IJyad/whisper-large-v3-Tarteel" npm run dev
```

The conversion is one-off tooling — it is **not** a Python dependency of the
running app. Candidate checkpoints (fastest → most accurate): `tarteel-ai/whisper-base-ar-quran`,
`MaddoggProduction/whisper-l-v3-turbo-quran-lora-dataset-mix` (balanced), and
`IJyad/whisper-large-v3-Tarteel` (max quality — the default suggestion here,
since you chose accuracy over speed).

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
├── data/quran.json              # bundled Quran text (114 surahs) — offline
├── src/
│   ├── lib/
│   │   ├── normalize.ts         # Arabic normalization (both sides of compare)
│   │   ├── align.ts             # tolerant word-level alignment + the verdict
│   │   ├── quran.ts             # text loading, range selection, provenance
│   │   ├── session.ts           # orchestration -> per-ayah report
│   │   ├── asr.ts               # transformers.js server-side wrapper
│   │   └── types.ts             # shared report types (client + server)
│   └── app/
│       ├── page.tsx             # the UI (recording, feedback, luqma, tuning)
│       ├── layout.tsx, globals.css
│       └── api/{surahs,check,luqma}/route.ts
└── tests/core.test.ts           # core logic tests (no model/audio needed)
```

> Keep `data/quran.json` at the project root — the server reads it at runtime.

## Where to take it next

- **Live mode:** stream audio, track position in real time, interrupt at the
  mistake, auto-prompt the next word on a pause.
- **Warmer feedback:** feed the structured per-ayah report to a local LLM for
  phrasing only — keep the verdict in code.
- **In-browser ASR:** transformers.js can also run client-side via WebGPU for a
  zero-backend, fully-offline variant (practical for smaller models).
