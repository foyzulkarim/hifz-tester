# ADR 0001 — How Node.js calls the Python ASR model

**Status:** Accepted (stdio worker retained as fallback; FastAPI loopback is the
live default)
**Date:** 2026-06
**Related:** [`../node-python-ipc.md`](../node-python-ipc.md),
[`../architecture.md`](../architecture.md)

## Context

The recitation recognizer is a Quran-fine-tuned **PyTorch Whisper** checkpoint
from HuggingFace (`transformers`). The application server is **Next.js /
TypeScript on Node**. These are two different language runtimes, so every
transcription has to cross a Node→Python boundary.

The forces that shaped the decision:

1. **The model is expensive to load** — 30–60s and ~1.5 GB into memory. Paying
   that per request is a non-starter; the model must load **once** and stay warm.
2. **No good Node-native path.** Running these specific fine-tunes in-process in
   Node would mean an ONNX conversion step that is fragile and lossy for these
   checkpoints. Calling the existing PyTorch pipeline directly is far simpler and
   keeps "drop in any HF Whisper model" true.
3. **Single-user, local-first.** No multi-tenancy, no network exposure required,
   no auth. Whatever we build only has to be correct and warm for one user on
   `localhost`.
4. **Audio is binary** — mono 16 kHz float32 PCM — and can be sizeable. The
   transport has to move raw bytes without corrupting them.

## The decision, and how it evolved

The transport went through three stages. The **stable seam** that survived all
of them is the single TypeScript contract every backend implements:

```ts
export async function transcribe(samples: Float32Array): Promise<string>;
```

Because that signature never changed, each transport swap below was a localized
change — the alignment engine, the API routes, and the UI never had to care.

### Stage 1 — naive per-request child execution (rejected)

The obvious first thing: shell out to `python asr.py <audio>` per request.

**Rejected immediately** against force #1 — it reloads the 30–60s model on every
single recitation. Unusable.

### Stage 2 — long-running child process over stdin/stdout (`child_process`)

Spawn the Python worker **once** from Node and keep it alive, exchanging
newline-delimited JSON (NDJSON) over the child's stdin/stdout. The model loads at
worker startup and stays warm. This is `src/lib/asr.ts` ↔ `scripts/asr.py`, and
it is still in the tree.

Why it works: warm model, **lowest dependencies** (just `transformers` + `torch`
+ `numpy`, no web framework), and Node fully owns the child's lifecycle. It's a
tiny JSON-RPC: a `ready` handshake, `_reqId` request/response correlation, line
buffering, and crash handlers that reject pending promises.

Where it hurt — the reasons we didn't stop here:

- **Binary audio doesn't belong in a newline-delimited text pipe.** A raw `\n`
  byte inside the float samples would split a message. We worked around it by
  writing the PCM to a temp `.raw` file and sending only the *path* over the
  pipe — but that's a workaround, not a clean fit.
- **Lifecycle is coupled to the Node process.** Every Next.js dev hot-reload /
  restart kills the child and re-pays the 30–60s model load. In a tight
  edit-run loop this is the single most painful cost.
- **Not independently observable.** You can't `curl` it or health-check it; it's
  only reachable through Node.
- **Doesn't share.** One Python child per Node process — N Node processes means
  N model copies in RAM.

### Stage 3 — FastAPI worker over TCP loopback (current default)

Run the warm model in a **standalone** uvicorn process bound to
`127.0.0.1:8765`, and have Node talk to it with plain `fetch`. This is
`src/lib/asr-fastapi.ts` ↔ `scripts/asr_fastapi.py`, and it's what the UI calls
today (`backend` is pinned to `fastapi` in `src/app/page.tsx`).

What moving to TCP bought us, mapped to the Stage 2 pain points:

- **Decoupled lifecycle — the big one.** The model survives Next.js restarts. Edit
  a route, hot-reload Node, and you do *not* re-pay the model load. This is the
  decisive day-to-day win.
- **Binary fits naturally.** Raw PCM goes straight in the HTTP request body as
  `application/octet-stream`; HTTP framing already carries length, so no temp
  file on the Node side and no text-protocol corruption risk.
- **Independently observable / debuggable.** `curl 127.0.0.1:8765/health` is a
  readiness probe; `curl --data-binary @clip.raw …/transcribe` reproduces a
  request with zero Node/browser involvement.
- **Shareable.** Several Next.js processes can point at one warm worker.

What it cost:

- Extra dependencies (`fastapi`, `uvicorn`) and a second process to run (handled
  by `npm run dev`, which starts both via `concurrently`).
- TCP overhead vs an in-process call. On loopback this is sub-millisecond and
  dwarfed by inference. **Note:** we use the *literal IP* `127.0.0.1`, not the
  hostname `localhost`, so there is **no DNS lookup** and none of the IPv6-first
  `localhost` connect delay; undici also keep-alives the connection across
  requests.

### Considered but not done — Unix Domain Sockets (UDS)

A UDS transport would remove the TCP port entirely (no port conflicts) and add
filesystem-permission-based access control. The latency gain over loopback TCP is
negligible for this workload, so it's **deferred**, not adopted. If we ever do
it, the change is local to two files — add uvicorn's `--uds` flag and swap the
`fetch` for `http.request({ socketPath })` — precisely because the
`transcribe()` contract above stays fixed.

## Why both backends still ship

We kept the Stage 2 stdio worker rather than deleting it:

- It's the **zero-extra-deps** path (no `fastapi`/`uvicorn`) — useful for
  low-resource or smoke-test runs.
- It needs **no second process** — Node spawns it on demand.

So: **FastAPI loopback is the default the UI uses; the stdio worker is the
lowest-friction fallback.** Both share the same audio format, the same
`stride_length_s=2` (load-bearing — see the worker source), and the same
`write_wav` helper.

## Consequences

- The transport is an implementation detail behind a stable `transcribe()` seam;
  swapping or adding a backend is a one-line change for callers. This is the real
  architectural asset — protect it.
- Operationally, the FastAPI worker must be running (`npm run dev` starts it). If
  it's down, `/api/check-fast` returns a clear "is the worker running?" 500
  rather than silently spawning anything.
- Throughput is effectively one transcription at a time today (the FastAPI
  endpoint is `async def` but calls the synchronous `pipe()`, blocking the event
  loop). Fine for single-user; the documented first fix for multi-user is `def`
  / `run_in_executor` plus a batching worker pool. See
  [`../node-python-ipc.md#scalability`](../node-python-ipc.md#scalability).
