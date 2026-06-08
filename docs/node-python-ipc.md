# Calling a Python model from Node, without paying for it every request

The speech recognizer is a Quran-fine-tuned **PyTorch Whisper** model. The app
server is **Next.js / TypeScript on Node**. Every transcription has to cross that
language boundary — and how you cross it is the difference between an app that
feels instant and one that's unusable.

The naive approach — shell out to `python transcribe.py audio.wav` per
request — is fatal, because the model takes **30–60 seconds and ~1.5 GB** to
load. Doing that on every recitation is a non-starter.

So the model is loaded **once** into a **long-lived Python worker** that stays
warm in memory, and Node talks to it across requests. Two things make this clean:

- **The model is loaded per *process*, not per *request*.** A request is just
  "here are the audio bytes," answered in the time it takes to run inference — the
  expensive load already happened at startup.
- **Node talks to the worker behind a single, stable contract**, so the transport
  underneath can change without touching any caller:

  ```ts
  export async function transcribe(samples: Float32Array): Promise<string>;
  ```

The app ships two implementations of that contract. The default — and the more
interesting one — is an HTTP worker over TCP loopback. A classic
`child_process` stdio worker is kept alongside it as a zero-dependency fallback.

---

## The default: a warm worker over TCP loopback (`/api/check-fast`)

A standalone [FastAPI](https://fastapi.tiangolo.com/) process
(`scripts/asr_fastapi.py`) loads the model at startup and serves it on
`http://127.0.0.1:8765`. Node (`src/lib/asr-fastapi.ts`) calls it with a plain
`fetch`, POSTing the raw audio bytes and reading back `{ "text": "…" }`.

```
Node (Next.js)  ──POST /transcribe (raw PCM bytes)──▶  FastAPI worker  ──▶ warm Whisper
     ▲                                                                          │
     └──────────────────  { "text": "…" }  ◀───────────────────────────────────┘
```

### Why TCP loopback is the better design here

**1. The model loads once per worker, not once per request — and it survives Node
restarts.**
This is the decisive win. Because the worker is a *separate process* with its own
lifecycle, you can edit a route, hot-reload the Next.js dev server, and the model
stays warm in the worker — you do **not** re-pay the 30–60s load. With an
in-process or Node-spawned worker, every code change that restarts Node would
reload the model. In a tight edit-run loop that is the single biggest cost, and
TCP eliminates it.

**2. The connection is reused, not reopened.**
Node's HTTP client keeps the loopback connection alive across requests
(keep-alive pooling), so back-to-back transcriptions reuse one socket instead of
re-handshaking each time. The per-request overhead is effectively just inference.

**3. Binary audio fits the transport natively.**
Audio is raw mono 16 kHz float32 PCM. It goes straight into the HTTP request body
as `application/octet-stream`; HTTP framing already carries the length, so there's
no encoding step, no temp file on the Node side, and no risk of the audio bytes
corrupting the protocol.

**4. The worker is independently observable and debuggable.**
Because it's just an HTTP service, you can talk to it without Node or a browser:

```bash
curl 127.0.0.1:8765/health                              # readiness probe
curl --data-binary @clip.raw 127.0.0.1:8765/transcribe  # reproduce a request
```

That makes "is it the model or the app?" a five-second question.

**5. One warm model can be shared.**
Several Next.js processes (or other clients) can point at the same worker instead
of each holding its own 1.5 GB copy in memory.

**6. No DNS, no `localhost` penalty.**
The URL uses the **literal IP `127.0.0.1`**, not the hostname `localhost`, so
there is no name resolution on the hot path — and none of the well-known
IPv6-first `localhost` connect delay. Sub-millisecond loopback overhead, dwarfed
by inference time.

The cost is honest and small: two extra Python dependencies (`fastapi`,
`uvicorn`) and a second process to run — which `npm run dev` starts for you
alongside Next.js.

---

## The fallback: a classic stdio worker (`/api/check`)

The repo also keeps the textbook way to call Python from Node: spawn it as a
child process and talk over **stdin/stdout** with newline-delimited JSON
(`src/lib/asr.ts` ↔ `scripts/asr.py`). Node spawns the child once and keeps it
warm, exchanging one JSON object per line:

```
Node → Python : {"_reqId":"7","audio_path":"/tmp/hifz-….raw"}
Python → Node : {"_reqId":"7","text":"بسم الله …"}
```

It's a tiny JSON-RPC: a `ready` handshake tells Node when the model has finished
loading, a `_reqId` on every message correlates responses to requests, the output
stream is line-buffered (a pipe read can split or merge messages), and
`close`/`error` handlers reject in-flight requests so a dead worker surfaces as a
clean error rather than a hang.

**Why keep it:** it has the **lowest possible footprint** — just `transformers` +
`torch` + `numpy`, no web framework — and **needs no second process**, since Node
owns the child directly. It's the right choice for a low-resource or smoke-test
run where you'd rather not install or manage a server.

**Why it isn't the default:** its lifecycle is tied to Node (restart Node and the
model reloads), binary audio doesn't fit a newline-delimited *text* pipe — so it's
passed as a temp-file *path* instead of inline — and it can't be `curl`-ed or
health-checked. Those are exactly the rough edges the TCP worker smooths out.

> Both workers expose the identical `transcribe()` signature, so the route is the
> only thing that differs — `/api/check-fast` (TCP) vs `/api/check` (stdio). The
> UI currently calls the TCP worker.

---

## Things both workers agree on

Whichever transport is used, these must match or results would drift between
them:

- **Audio format** — mono, 16 kHz, float32 little-endian PCM. The browser
  produces exactly this via an `OfflineAudioContext` resample before sending, so
  the server never has to guess the mic's sample rate.
- **`stride_length_s=2`** — load-bearing. The 4-layer turbo decoder loses context
  and enters infinite repetition loops during silence with longer strides.
- **`write_wav()`** — the pipeline wants a file it can sniff, so both workers wrap
  the raw PCM in a WAV container the same way.

## A note on scale

This is a single-user, local tool, and the design is right for that: one warm
model, near-zero per-request overhead, loopback-only (no auth needed). Throughput
today is effectively one transcription at a time — the FastAPI endpoint is
declared `async def` but calls the synchronous Whisper pipeline, which blocks the
event loop. For multi-user use the first fix is to run that call off the loop
(`def` so Starlette threadpools it, or `run_in_executor`) and put a batching
worker pool behind it. Crucially, none of that changes the `transcribe()` contract
the rest of the app depends on — which is the whole point of putting a stable seam
there.

## Configuration

| Variable | Default | Used by |
|---|---|---|
| `HIFZ_ASR_MODEL` | `MaddoggProduction/whisper-l-v3-turbo-quran-lora-dataset-mix` (TCP) · `tarteel-ai/whisper-base-ar-quran` (stdio) | both workers |
| `HIFZ_ASR_FASTAPI_URL` | `http://127.0.0.1:8765/transcribe` | TCP worker |
| `HIFZ_PYTHON` | `python3` | stdio worker |
