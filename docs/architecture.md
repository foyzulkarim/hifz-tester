# Architecture

Hifz Tester is a local, single-user web app that acts as the *listening teacher*
in hifz (Quran memorization): you recite a chosen ayah range, it transcribes you
on the server, and it tells you — at the level of the individual word — whether
you were correct or exactly where you slipped.

This document is the map of the system as it stands. The Node↔Python speech
bridge — the most interesting part — has its own write-up in
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
| UI | `src/app/page.tsx` | record, decode/resample, render report, luqma + tuning panels |
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

## Load-bearing decision #2 — a warm Python model behind a stable seam

The speech model is expensive to load (30–60s, ~1.5 GB), so it loads **once** in
a long-lived Python worker and stays warm. Node calls it behind a single
TypeScript contract — `transcribe(samples: Float32Array): Promise<string>` — so
the transport underneath can change without touching any caller. The live
transport is a FastAPI worker over TCP loopback (`/api/check-fast`); a classic
stdio child worker (`/api/check`) ships as a zero-dependency fallback.

Why this matters, what TCP buys over spawning Python per request, and how the
stdio fallback works are covered in
[`node-python-ipc.md`](./node-python-ipc.md).

## Scope and non-goals

- **Word-level correctness only** — not tajweed grading.
- **Record-then-review**, not live interruption.
- **Single local user** — loopback only, no auth, no multi-tenancy.
- **Hafs ʿan ʿĀsim**, plain-script reference (diacritics ignored for matching).
