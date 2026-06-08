# ADR 0001 — How Node.js calls the Python ASR model

**Status:** Accepted — FastAPI over loopback is the live default; a stdio child
worker ships as a zero-dependency fallback.
**Related:** [`../node-python-ipc.md`](../node-python-ipc.md),
[`../architecture.md`](../architecture.md)

## The problem

The recitation recognizer is a Quran-fine-tuned **PyTorch Whisper** checkpoint
(`transformers`). The app server is **Next.js / TypeScript on Node**. Two
runtimes, so every transcription must cross a Node→Python boundary — and how that
boundary is built determines whether the app is usable.

Four forces decide the design:

1. **The model is expensive to load** — 30–60s and ~1.5 GB into memory. So it
   must load **once** and stay warm; it can never be loaded per request.
2. **There is no clean Node-native path.** Running these specific fine-tunes
   inside Node would require a fragile, lossy ONNX conversion. Calling the
   existing PyTorch pipeline directly is simpler and keeps "drop in any
   HuggingFace Whisper model" true.
3. **Single-user, local-first.** One user on `localhost`. No multi-tenancy, no
   network exposure, no auth to design around.
4. **Audio is raw binary** — mono 16 kHz float32 PCM, and sizeable. The transport
   must move bytes without corrupting them.

## The decision

**Run the warm model in a long-lived Python process, and talk to it from Node
behind a single, stable contract:**

```ts
export async function transcribe(samples: Float32Array): Promise<string>;
```

Two things follow from this, and they're the whole point:

- **Warm, out-of-process model.** Python owns the model and keeps it loaded
  between requests, satisfying force #1 without an ONNX rewrite (#2).
- **A stable seam, not a fixed transport.** Every backend implements that exact
  signature, so the alignment engine, the API routes, and the UI never know
  which transport is live. Choosing or changing the transport is a localized
  change, not a refactor. **This seam is the real architectural asset — protect
  it.**

The live transport behind the seam is **FastAPI over loopback HTTP**
(`127.0.0.1:8765`); a **stdin/stdout child process** is kept as a fallback. The
reasoning for each follows.

## Why FastAPI over loopback (the default)

A standalone uvicorn process holds the warm model; Node calls it with `fetch`.
What this buys:

- **Decoupled lifecycle — the decisive benefit.** The model survives Next.js
  restarts and hot-reloads. You edit a route, Node reloads, and you do **not**
  re-pay the 30–60s model load. In a tight edit-run loop this is the difference
  between pleasant and unbearable.
- **Binary fits the transport natively.** Raw PCM goes straight in the HTTP body
  as `application/octet-stream`. HTTP framing carries the length, so there's no
  risk of binary corrupting the protocol and no temp file on the Node side
  (force #4, cleanly).
- **Independently observable.** `curl 127.0.0.1:8765/health` is a readiness
  probe; `curl --data-binary @clip.raw …/transcribe` reproduces a request with
  zero Node or browser involvement. You can debug the model in isolation.
- **Shareable.** Several Next.js processes can point at one warm worker instead
  of each holding its own copy.

The cost is modest and bounded: two extra deps (`fastapi`, `uvicorn`) and a
second process to run (`npm run dev` starts both). Loopback TCP adds
sub-millisecond overhead, dwarfed by inference — and we use the **literal IP
`127.0.0.1`, not the hostname `localhost`**, so there is **no DNS lookup** and
none of the IPv6-first `localhost` connect delay; the connection is also
kept-alive across requests.

## Why also keep a stdin/stdout child worker

A second backend talks to a Python child over newline-delimited JSON on
stdin/stdout (Node spawns and owns it). It's retained because it is the
**lowest-friction** option:

- **Zero extra deps** — just `transformers` + `torch` + `numpy`, no web
  framework. Good for low-resource or smoke-test runs.
- **No second process to manage** — Node spawns it on demand.

Its trade-offs are exactly what motivated the FastAPI default: its lifecycle is
coupled to Node (so it re-loads the model on every restart), binary audio doesn't
fit a text pipe (it's passed as a temp-file path instead), and it can't be
`curl`-ed. So: **FastAPI is the default; stdio is the fallback when you want
nothing but Python installed.**

Both backends share the same audio format, the same load-bearing
`stride_length_s=2`, and the same `write_wav` helper — keep them in sync.

## Alternatives rejected

- **Spawn `python` per request.** The obvious approach, fatal against force #1:
  it reloads the model on every recitation. Unusable.
- **Run Whisper natively in Node (ONNX / transformers.js).** Avoids the boundary
  entirely, but the ONNX conversion for these fine-tunes is fragile and lossy,
  and it gives up "drop in any HF checkpoint." A plausible *future* path for
  smaller models via WebGPU, not the right default now.
- **Unix Domain Sockets instead of loopback TCP.** Would drop the TCP port (no
  port conflicts) and add filesystem-permission access control. But the latency
  gain over loopback is negligible here, so it's **deferred** — and thanks to the
  stable `transcribe()` seam, adopting it later is a two-file change (uvicorn
  `--uds` flag; swap `fetch` for `http.request({ socketPath })`).

## Consequences

- Adding or swapping a transport is a one-line change for callers; the seam keeps
  that cheap.
- The FastAPI worker must be running for the default path; if it's down,
  `/api/check-fast` returns a clear "is the worker running?" error rather than
  silently doing anything.
- Throughput is effectively one transcription at a time today (the FastAPI
  endpoint is `async def` but calls the synchronous `pipe()`, blocking the event
  loop). Correct for single-user; the documented first fix for multi-user is
  `def` / `run_in_executor` plus a batching worker pool — see
  [`../node-python-ipc.md#scalability`](../node-python-ipc.md#scalability).
