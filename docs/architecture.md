# Architecture

Hifz Tester is a local, single-user web app that acts as the *listening teacher*
in hifz (Quran memorization): you recite a chosen ayah range, it transcribes you
on the server, and it tells you — at the level of the individual word — whether
you were correct or exactly where you slipped.

This document covers the system shape and the two design decisions that carry the
project. For the Node↔Python bridge specifically, see
[`node-python-ipc.md`](./node-python-ipc.md).

## Data flow

```
  browser                         server (Next.js, Node runtime)
  ───────                         ──────────────────────────────
  mic record                      ┌─ /api/check       ─▶ asr.ts (stdio worker)
     │                            │                         │
  decode + resample        POST   │                    scripts/asr.py  (warm Whisper)
  to 16 kHz mono PCM  ───────────▶│                         │
  (OfflineAudioContext)           └─ /api/check-fast  ─▶ asr-fastapi.ts ─▶ HTTP
                                                            │   127.0.0.1:8765
                                                       scripts/asr_fastapi.py (warm Whisper)
                                                            │
                                                       transcript (Arabic text)
                                                            │
   reference ayah text ─▶ normalize ◀──── normalize ◀───────┘
   (data/quran-enhanced.json)                  │
                                          align (deterministic, tolerant)
                                               │
                                  group by ayah → per-ayah verdict
                                  + pinpointed word + next-word hint
                                               │
                                       SessionReport JSON ─▶ UI
```

The client is a single React page (`src/app/page.tsx`). It records from the mic,
decodes and resamples the blob to **mono 16 kHz float32 PCM** in the browser
(`toMono16k()` via `OfflineAudioContext`), and POSTs the raw bytes. Doing the
resample client-side means the server always receives exactly the format the ASR
model expects, regardless of the user's mic sample rate.

## Module map

| Layer | File | Responsibility |
|---|---|---|
| UI | `src/app/page.tsx` | record, decode/resample, backend toggle, render report, luqma + tuning panels |
| API | `src/app/api/check/route.ts` | stdio backend endpoint |
| API | `src/app/api/check-fast/route.ts` | FastAPI backend endpoint |
| API | `src/app/api/{surahs,luqma}/route.ts` | surah list; manual next-word hint |
| ASR client | `src/lib/asr.ts` | stdio NDJSON client → `scripts/asr.py` |
| ASR client | `src/lib/asr-fastapi.ts` | HTTP client → `scripts/asr_fastapi.py` |
| ASR worker | `scripts/asr.py` | warm Whisper, stdin/stdout NDJSON |
| ASR worker | `scripts/asr_fastapi.py` | warm Whisper, FastAPI on loopback |
| Engine | `src/lib/normalize.ts` | Arabic normalization (applied to both sides) |
| Engine | `src/lib/align.ts` | tolerant word-level LCS alignment + verdict |
| Engine | `src/lib/quran.ts` | text loading, range selection, token provenance |
| Engine | `src/lib/session.ts` | orchestration → `SessionReport` |
| Engine | `src/lib/types.ts` | shared report types (client + server) |
| Data | `data/quran-enhanced.json` | bundled Quran text, 114 surahs, offline |

## Load-bearing decision #1 — the verdict is decided in code, never by an LLM

Because the reference text is known, "did they recite it correctly?" is a
**verification** problem, not a generation problem. So the correctness verdict is
produced by deterministic code in `src/lib/align.ts`:

- The same recitation + transcript always yields the same verdict (reproducible,
  inspectable, testable without a GPU).
- Two layers keep ASR noise from masquerading as reciter mistakes:
  - **Normalization** (`normalize.ts`) folds diacritics, tatweel, Quranic
    annotation marks, and orthographic variants (`أإآ→ا`, `ة→ه`, `ى→ي`, …) on
    *both* sides before comparison, so only meaningful differences survive.
  - **Tolerant alignment** (`align.ts`) computes an LCS-based word alignment,
    then treats a single-word substitution whose *character* similarity clears a
    threshold (default `0.80`) as the recognizer fumbling a correct word rather
    than flagging you.

Each expected token carries provenance (`{surah, ayah, wordIndex}`), so a flat
alignment can be reported back as "ayah 3, word 5 was substituted." An LLM is
only ever a *future, optional* layer for warmer phrasing of the already-decided
report — never the judge.

This is what makes the core trustworthy and fully unit-tested
(`tests/core.test.ts`) with no model and no audio.

## Load-bearing decision #2 — warm model behind a swappable transport

The model is expensive to load (30–60s, ~1.5 GB), so it loads **once** in a
long-lived Python worker and stays warm. Two interchangeable workers implement
this behind one identical TypeScript contract
(`transcribe(samples: Float32Array): Promise<string>`):

- **stdio NDJSON** (`asr.ts` ↔ `asr.py`) — lowest dependencies, Node owns the
  child process lifecycle. Serves `/api/check`; default model
  `tarteel-ai/whisper-base-ar-quran`.
- **FastAPI loopback** (`asr-fastapi.ts` ↔ `asr_fastapi.py`) — decoupled
  lifecycle, `curl`-debuggable, shareable across processes. Serves
  `/api/check-fast`; default model
  `MaddoggProduction/whisper-l-v3-turbo-quran-lora-dataset-mix`.

> **Currently live:** the UI pins the backend to `fastapi`
> (`src/app/page.tsx`), so every recitation today is served by `/api/check-fast`
> and the MaddoggProduction turbo model. The stdio path is wired and tested but
> unreachable from the UI until the commented-out backend toggle is restored.

The full rationale, wire protocols, robustness details, and a scalability
analysis live in [`node-python-ipc.md`](./node-python-ipc.md). The *why* behind
the decision — the forces, the benefits, and the alternatives rejected — is
recorded in [ADR 0001](./adr/0001-node-python-asr-bridge.md).

## Scope and non-goals

- **Word-level correctness only** — not tajweed grading.
- **Record-then-review**, not live interruption.
- **Single local user** — loopback only, no auth, no multi-tenancy.
- **Hafs ʿan ʿĀsim**, plain-script reference (diacritics ignored for matching).

See the README's "Honest limitations" and "Where to take it next" for the
roadmap (live streaming mode, warmer LLM phrasing, in-browser WebGPU ASR).
