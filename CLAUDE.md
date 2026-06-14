# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Development (Next.js only — assumes FastAPI worker is already running separately)
npm run dev

# Development with external FastAPI ASR worker (remote/LAN IP)
npm run dev:all           # sets HIFZ_ASR_FASTAPI_URL and runs next dev

# Start the FastAPI ASR worker locally (warm Whisper, loopback)
npm run dev:asr           # uvicorn with --reload (dev)
npm run asr:start         # uvicorn without --reload (prod)

# Build and production
npm run build
npm start                 # production Next.js + remote FastAPI URL

# Quality
npm run typecheck
npm run lint

# Tests (no model, no audio required)
npm test                  # core.test.ts + asr-fastapi.test.ts
npm run test:core         # deterministic engine only
npm run test:asr          # live FastAPI integration (worker must be running)
```

## Architecture

### The two ASR backends

The app ships two ways to call the Whisper model, both behind the same `transcribe(samples: Float32Array): Promise<string>` contract:

| Route | TS client | Python worker | Transport |
|---|---|---|---|
| `/api/check` | `src/lib/asr.ts` | `scripts/asr.py` | stdio NDJSON child process |
| `/api/check-fast` | `src/lib/asr-fastapi.ts` | `scripts/asr_fastapi.py` | HTTP to `127.0.0.1:8765` |

The FastAPI path (`check-fast`) is the primary path. The stdio path (`check`) is a zero-dependency fallback. The UI calls `/api/transcribe` (FastAPI) then `/api/verify` (pure text) as a two-step split: transcribe once, re-verify cheaply when the range or threshold changes.

### The deterministic verification engine

**Verdict is decided in code, never by an LLM.** The pipeline:

1. `src/lib/quran.ts` — loads `data/quran-enhanced.json`, returns typed `Verse[]` with provenance (`{surah, ayah, wordIndex}`) on every token
2. `src/lib/normalize.ts` — Arabic normalization applied to **both** sides: strips tashkeel/tatweel/Quranic marks, folds alef variants (`أإآٱ→ا`), `ة→ه`, `ى→ي`, etc.
3. `src/lib/align.ts` — LCS-based word alignment producing `Op[]` (`match/substitution/omission/insertion`). A substitution with character similarity ≥ `SIMILARITY_THRESHOLD` (default `0.80`) is downgraded to a match (ASR noise tolerance). Tune this constant or pass `threshold` as a query/body param.
4. `src/lib/session.ts` — orchestrates 1–3, groups ops by ayah provenance into `AyahResult[]`, computes `nextWord` hint, returns `SessionReport`

### Additional API routes

- `GET /api/surahs` — surah list from `data/surahs.json`
- `GET /api/ayahs?surah=N` — verse count for a surah
- `POST /api/detect-range` — auto-detects `{from, to}` ayah range in a surah from a transcript (same normalization as engine)
- `POST /api/luqma` — manual next-word hint lookup (no model)

### Key types (`src/lib/types.ts`)

`SessionReport` is the wire shape returned by all check/verify routes. `AyahResult.clean` is the per-ayah boolean verdict. `AyahNote` carries `{kind, wordIndex, expected, heard}` for pinpointed mistakes.

### Audio path

The browser records mic audio, decodes and resamples to **mono 16 kHz float32 PCM** via `OfflineAudioContext` (`toMono16k()`), and POSTs raw bytes. The server receives exactly the format Whisper expects regardless of the user's mic sample rate.

### Data files (`data/`)

- `quran-enhanced.json` — bundled Quran text (114 surahs), includes translation and transliteration fields; loaded at server start, never fetched at runtime
- `surahs.json` — surah metadata
- `en.sahih.txt`, `en.transliteration.txt` — plain-text sources used during data preparation

## Invariants to preserve

- The deterministic core (`normalize.ts`, `align.ts`, `session.ts`) has no external dependencies and is fully unit-tested without a model or audio. Keep `npm run test:core` green for any change touching these files.
- The verdict must stay in `align.ts` — no LLM decides correctness. A local LLM may only be used for *phrasing* the already-decided `SessionReport`.
- Both ASR routes must produce a `SessionReport` with identical shape so the client can swap between them.
- `SIMILARITY_THRESHOLD` in `align.ts` is the single knob for match tolerance — don't add per-word or per-surah overrides without strong justification.
