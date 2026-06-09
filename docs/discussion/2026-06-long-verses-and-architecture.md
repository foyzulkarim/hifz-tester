# Discussion log — long verses, decoupling, audio feedback, monetization

A captured brainstorm so the reasoning behind some decisions isn't lost. This is
a design conversation, not a spec — treat it as context, not a contract. Only one
item here was actually built (the 60s cap); everything else is a recorded
direction we can pick up later.

---

## 1. Long ayat that can't be recited under 30s

**Problem.** Some individual verses take well over 30s to recite, but recording
was hard-capped at 30s, so those verses got cut off and verified incompletely.

**Key realization.** The 30s number lived in two unrelated places:

- `MAX_RECORD_SECONDS` in the client (`src/app/page.tsx`) — a UX timer, arbitrary.
- `chunk_length_s=30` in the ASR worker — **not** a max length. It's Whisper's
  sliding-window size for long-form audio; with `stride_length_s` overlap it
  transcribes audio of *any* length.

The verification engine (`align.ts` / `session.ts`) is a Longest-Common-
Subsequence word alignment. It is **time-agnostic** — it only needs the words in
order. So there is no "which half of the ayah is this" problem to solve.

**Options considered.**

- **A — record longer, send one blob (chosen).** Whisper already handles
  long-form with overlapping windows; nothing downstream changes.
- **B — client-side chunk array.** Rejected: more code, and hard-cutting at a
  fixed boundary splits the word at the seam (worse accuracy). The "ordering"
  worry is a non-issue — array index already is time order. Only an external
  payload/timeout limit would ever justify this.

**Why the old 30s cap existed.** Git history shows chunking was present from the
first commit, so the cap was never a model *capability* limit. It was a
workaround for the older small base model degrading into **repetition loops** on
long-form audio. The current larger fine-tuned turbo model with a tuned stride is
far more robust, so raising the cap is reasonable now.

**Decision (shipped).** Bump `MAX_RECORD_SECONDS` to **60s** — covers long single
verses. Reciting *many* verses at once stays a selection/UX concern (pick an ayah
range), not an audio-length concern.

**Open caveat.** Long-form robustness is empirical and model-specific. Worth
spot-checking a real ~60s recitation for repetition loops; if it loops, that's a
worker stride/model issue, not something the cap (or chunking) fixes.

---

## 2. Decoupling the ASR service onto a separate GPU host

**Idea.** Keep the Next.js app where it is; move the Python transcriber to a
separate GPU machine on the same network. Frontend changes then never restart the
warm model, the GPU is used for what it's good at, and a future
edge-hosted frontend is already decoupled from the model.

**Finding.** The FastAPI path is *already* a clean HTTP service, not a co-process.
`src/lib/asr-fastapi.ts` reads `HIFZ_ASR_FASTAPI_URL` (defaulting to loopback).
Decoupling is mostly config:

1. Bind the worker to `0.0.0.0` instead of loopback on the GPU host.
2. Set `HIFZ_ASR_FASTAPI_URL` to the GPU host's address on the app host.

The contract stays: `POST` raw mono-16k audio bytes → `{ text }`, plus `/health`.

**The clean split we converged on (and endorsed):**

- **Frontend** — capture + resample to 16k mono. Stateless.
- **Verification** (`align` / `normalize` / `session` / `quran`) — pure,
  deterministic TypeScript over a JSON data file. No model, no GPU, stateless.
- **ASR service** — the only heavy, hardware-bound piece. Stateless per request.

This split is why the move is cheap and why an edge frontend is realistic — the
verification logic is pure TS and could run at the edge unchanged.

---

## 3. Securing the GPU (no user accounts)

**The trust-boundary correction.** There are two boundaries with different threat
models:

1. **Public → app's `/api/check-fast`** — the *real* GPU-abuse surface. Anyone who
   can reach the app can trigger a transcription.
2. **App → ASR service** — protects the GPU from *other machines/processes*.

A shared token between the app and the ASR service secures boundary 2, but does
**not** stop public abuse via boundary 1 — the app server holds the token and
forwards faithfully. So defense is needed at both layers:

- **Shared token (app ↔ ASR):** server-side only, never in the browser bundle.
  One `Authorization: Bearer …` header added by the client lib, one constant-time
  check in the worker. Stored in env, not committed.
- **Edge rate-limiting / bot-gating:** this is what actually caps public GPU
  abuse. A per-IP rate-limit rule on the transcribe endpoint, optionally a
  human-check challenge (good fit for an account-less app).

**Future edge-frontend variant.** When the UI moves to an edge worker, the token
becomes a worker secret, and the ASR host's tunnel should be locked so only the
worker can reach it (service-token style) rather than being publicly hittable.

---

## 4. Audio size optimization

Audio currently goes over the wire as **float32** (~3.8 MB for 60s). The
expensive hop (browser → app over the internet) already exists today; moving the
GPU to another host only adds a cheap LAN hop.

| Format | ~size (60s) | Server change | Verdict |
| --- | --- | --- | --- |
| float32 (today) | ~3.8 MB | none | wasteful over internet |
| **int16 PCM** | ~1.9 MB | trivial cast | **recommended** |
| Opus/WebM | ~0.3–0.6 MB | server-side decode (ffmpeg) | defer |

**Decision (deferred to build):** switch to **int16** — halves bandwidth, no
quality loss for ASR, change is just a cast on each end. Opus is a bigger win but
adds a server decode dependency; not worth it until many mobile users on slow
links.

---

## 5. Scalability posture

One GPU, no accounts, public URL → the real risk is a **spike**, not steady load.
Inference serializes, so overload shows up as a growing queue and timeouts.

**Proportionate response (don't over-build):**

- **Backpressure, not a queue.** A semaphore in the ASR service (max 1–2
  concurrent); return `429` immediately when full; surface a friendly
  "server busy, try again" in the UI.
- Revisit a real job queue + multiple workers only if it genuinely outgrows one
  GPU. The decoupled contract already allows adding a second worker behind it.

**Resilience / ops (deferred):** run the worker under a service manager
(auto-restart, warm model on boot); keep the local stdio worker as an emergency
fallback when the GPU host is down (this is the one good reason to keep that
second code path); add per-request latency + model-id logging and a request
counter to notice abuse early.

---

## 6. Audio feedback (a teacher that recites, not just spell-checks)

**Why it matters here.** Hifz is an oral/aural discipline. Text feedback says
*which* word; only audio can convey *pronunciation and tajwid*. It also helps the
user disambiguate genuine mistakes from ASR mishearings.

**Non-negotiable design rule.** **Never synthesize Quranic Arabic with a generic
TTS.** Mispronounced/mis-voweled synthesized Quran is unacceptable. The Arabic in
any feedback must always be **authentic human reciter audio**. TTS is fine only
for the instructional wrapper in the learner's language.

**Elegant architecture (no runtime TTS).** A teacher's correction decomposes into
two parts: a short instruction in the learner's language + the correctly recited
Arabic. The instruction set is **small and closed** ("you missed a word", "the
correct word is…", "extra word", "try again", "well done"). So:

- Pre-render the closed instruction set once, per language (static audio assets).
- Map the Arabic to authentic per-word/per-ayah reciter audio. The report already
  carries `{ surah, ayah, wordIndex }`, so word-level targeting maps directly.
- The frontend stitches `[instruction in locale] → [authentic Arabic audio]`.

Consequences: backend/GPU untouched, fully static + cacheable (edge-friendly),
and multilingual = swap the instruction pack. No runtime TTS infra.

**Tiers by benefit/effort.**

1. **Authentic reference playback** — tap a flagged word, hear the correct
   recitation. Highest value, lowest risk. Build first.
2. **Multilingual spoken correction** — the stitched instruction + Arabic flow.
   Nearly free once tier 1's audio map exists.
3. **Replay user's own recording at the error point** — needs word-level
   timestamps (`return_timestamps=True` + alignment). Defer; ship a "replay whole
   clip" stopgap first (we already hold the recording client-side).

**To nail down before building:** reciter-audio source + licensing; graceful
fallback to ayah-level audio where word-level coverage is missing; whether
instruction snippets are human-recorded or TTS-rendered (a one-time asset either
way).

---

## 7. Mobile app / monetization (explored, parked)

**Decision:** **no pricing and no premium features for now.** Stay free as long as
it can be freely supported; revisit only if the GPU starts crumbling. The idea
isn't unique enough that existing Quran apps couldn't build it, so differentiation
matters more than a paywall.

Notes kept for if/when this is revisited:

- **Optics first.** Quran tooling has a strong "should be free" expectation. If
  ever monetized, gate the *memorization tooling* (analytics, coaching,
  reminders), never the Quran text itself, and consider a "support the project"
  framing and purchasing-power pricing for major Hifz regions.
- **Retention, not the checker, drives subscriptions.** The checker is the hook;
  the *system* (spaced-repetition review, progress/weak-spot analytics, streaks +
  reminders) is what retains. SRS is the standout feature for memorization.
- **Distribution:** PWA to validate → a web-wrapper (e.g. Capacitor) for app-store
  presence + push notifications. Native-from-scratch only if it becomes the core
  product.
- **B2B / madrasa LMS** looked like the more promising and less crowded market
  (teacher/parent monitors students; sell seats to schools). **Deferred to its own
  discussion.**
- **Quality bar:** any error in Quran text or feedback is reputationally fatal —
  QA standard must be higher than a typical app.

---

## Status summary

- **Shipped:** 60s recording cap.
- **Designed, not built:** ASR decoupling (token + bind + env URL), edge
  rate-limit, int16 wire format, service-manager + stdio fallback, semaphore
  backpressure, audio feedback (tiers 1–2).
- **Parked:** user's-own-audio replay (needs timestamps), pricing/premium
  features, B2B/LMS (own discussion).
