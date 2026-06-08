# Calling Python from Node.js: two patterns, one contract

The model that transcribes recitation is a PyTorch Whisper checkpoint. The app
is a Next.js / TypeScript server. Bridging those two runtimes is the genuinely
interesting engineering in this project, so it gets its own document.

The hard requirement that shapes everything below:

> **The model must load once and stay warm.** A Quran-fine-tuned Whisper takes
> 30–60s and 1.5 GB to load. Paying that on every request is a non-starter, so
> "shell out to `python asr.py`" per request was never an option.

The app ships **two** Node→Python bridges that solve this the same way (a
long-lived Python process holding a warm model) but over different transports.
Critically, they expose the **identical TypeScript contract**:

```ts
export async function transcribe(samples: Float32Array): Promise<string>;
```

Because the signature is identical, the alignment engine and API routes don't
know or care which backend is live. Swapping is a one-line import change
(`@/lib/asr` ↔ `@/lib/asr-fastapi`), and the route chosen per request is just
`/api/check` vs `/api/check-fast`.

> **What's live today:** the client backend is currently pinned to `fastapi`
> (`const backend: Backend = 'fastapi'` in `src/app/page.tsx`; the state hook and
> the fast/slow toggle UI are commented out). So every recitation goes through
> `/api/check-fast` and the **`MaddoggProduction/whisper-l-v3-turbo-quran-lora-dataset-mix`**
> model. The stdio path below is fully functional but unreachable from the UI
> until the toggle is restored.

| | stdio worker | FastAPI worker |
|---|---|---|
| File | `scripts/asr.py` + `src/lib/asr.ts` | `scripts/asr_fastapi.py` + `src/lib/asr-fastapi.ts` |
| Transport | stdin/stdout NDJSON pipe | loopback HTTP (`127.0.0.1:8765`) |
| Lifecycle | spawned & owned by Node (`child_process.spawn`) | separate process (uvicorn) |
| Audio payload | temp `.raw` file, path sent over pipe | raw octet-stream request body |
| Deps | `transformers`, `torch`, `numpy` | + `fastapi`, `uvicorn` |
| Debuggable with `curl` | no | yes (`/health`, `/transcribe`) |
| Default model | `tarteel-ai/whisper-base-ar-quran` | `MaddoggProduction/whisper-l-v3-turbo-quran-lora-dataset-mix` |
| Used by | `/api/check` (not reachable from UI today) | `/api/check-fast` (**what the UI calls now**), `npm run dev` |

---

## Pattern 1 — stdio NDJSON worker (a tiny JSON-RPC over pipes)

`src/lib/asr.ts` spawns `scripts/asr.py` **once** and keeps it alive for the
lifetime of the Node process. Requests and responses are newline-delimited JSON
flowing over the child's stdin/stdout. It is, in effect, a minimal JSON-RPC.

### The wire protocol

```
Node  -> Python : {"_reqId":"7","audio_path":"/tmp/hifz-….raw"}\n
Python -> Node  : {"_reqId":"7","text":"بسم الله …"}\n
              or  {"_reqId":"7","error":"…"}\n
```

Plus a one-time startup handshake so Node knows the slow model load is done:

```
Python -> Node : {"status":"ready","model":"tarteel-ai/whisper-base-ar-quran"}\n
```

### The four things that make this robust

1. **Ready handshake.** Python prints `{"status":"ready"}` *after* the model is
   loaded. Node's `waitForReady()` blocks the first `transcribe()` until that
   arrives (polling a `_ready` flag with a 120s ceiling). No request is ever
   sent into a cold worker.

2. **Request/response correlation.** stdout is one shared stream, so every
   message carries a `_reqId`. Node keeps a `Map<reqId, {resolve, reject}>` of
   in-flight promises; when a line arrives it looks up the id, settles that
   promise, and deletes the entry. This is what would let multiple requests be
   outstanding at once without their answers getting crossed. (The Python side
   still processes them sequentially — see [scalability](#scalability).)

3. **Line buffering.** TCP/pipe reads don't respect message boundaries — a
   single `data` event may contain half a line, or three lines. Node accumulates
   into `_buffer`, splits on `\n`, and keeps the trailing partial for next time:

   ```ts
   _buffer += data.toString();
   const lines = _buffer.split("\n");
   _buffer = lines.pop() ?? "";   // last element is the incomplete tail
   for (const line of lines) { /* parse + dispatch */ }
   ```

4. **Crash safety.** `proc.on("error")` and `proc.on("close")` both reject every
   pending promise and reset the singleton, so a dead worker surfaces as a clean
   rejected `transcribe()` rather than a hang. Each request also has its own 60s
   timeout via `Promise.race`.

### Why a temp file instead of piping the audio bytes

Audio is passed by **writing a `.raw` file and sending its path** over the pipe,
not by streaming the PCM through stdin. Two reasons:

- Mixing large binary blobs into a newline-delimited *text* protocol is asking
  for framing bugs (a raw `\n` byte inside float samples would split a message).
- The HuggingFace pipeline wants a file it can sniff the format of anyway.

Node writes float32 PCM to `/tmp/hifz-<ts>-<rand>.raw`; Python `np.fromfile`s it,
wraps it in a WAV container, transcribes, and both sides clean up their own temp
file in a `finally`.

---

## Pattern 2 — FastAPI loopback worker

`scripts/asr_fastapi.py` is the same warm-model idea, but the worker is a
standalone uvicorn process bound to `127.0.0.1:8765`, and Node talks to it with
plain `fetch`. `src/lib/asr-fastapi.ts` POSTs the raw PCM as an
`application/octet-stream` body and reads `{ "text": … }` back.

What you buy by paying for an extra process and an HTTP dep:

- **Decoupled lifecycle.** The model survives Next.js restarts. Edit a route,
  hot-reload Node, and you don't re-pay the 60s model load. You can also point
  several Next.js processes at one warm worker.
- **`curl`-debuggable.** `curl 127.0.0.1:8765/health` is a readiness probe;
  `curl --data-binary @clip.raw 127.0.0.1:8765/transcribe` reproduces a request
  with zero browser/Node involvement.
- **A clean seam for future transports.** Moving to a Unix domain socket later
  is local to two files: add uvicorn's `--uds` flag and swap the `fetch` for
  `http.request({ socketPath })`.

Here the bytes go straight in the request body (HTTP framing already handles
length), so there's no temp file on the Node side — only Python writes a WAV
for the pipeline to read.

---

## Shared invariants (keep these in sync across both workers)

Both Python workers must agree on these or results drift between backends:

- **Audio format:** mono, 16 kHz, float32 little-endian PCM. The browser
  produces this in `toMono16k()` via an `OfflineAudioContext` resample
  (`src/app/page.tsx`); both workers assume it.
- **`stride_length_s=2`.** Load-bearing. The 4-layer turbo decoder
  (`whisper-l-v3-turbo`) loses context and enters **infinite repetition loops**
  during silence with longer strides. Both workers pin it.
- **`write_wav()`** is duplicated verbatim in both scripts on purpose (keeps each
  worker a single self-contained file). If you touch one, touch the other.
- **Device selection:** `mps` on Apple Silicon, else `cpu`. Hard-coding `mps`
  crashes on Linux/Intel.

---

## Scalability

This is a **single-user, local-first** tool, and for that target the design is
deliberately right: one warm model, near-zero per-request overhead, no network
exposure (loopback only), no auth needed. Within scope: yes, it scales fine.

If you ever wanted to serve *many concurrent users*, here's the honest list of
what currently caps throughput at effectively one transcription at a time, and
what each would take to fix:

1. **The stdio worker is sequential.** `asr.py` reads stdin in a single
   `for line in sys.stdin` loop and transcribes one clip before reading the
   next. The Node-side `_reqId` plumbing *supports* concurrency, but the worker
   doesn't deliver it. Fix: a worker pool, or batch the pipeline.

2. **The FastAPI endpoint blocks the event loop.** `transcribe` is declared
   `async def` but calls the synchronous `pipe(...)` directly, so it blocks
   uvicorn's loop and requests serialize regardless. Easy, real fix: declare it
   `def` (Starlette runs sync endpoints in a threadpool) or wrap the call in
   `run_in_executor`. Then add a worker pool / GPU batching for actual parallel
   throughput.

3. **Module-global singletons in `asr.ts`** (`_python`, `_pending`) mean one
   Python child *per Node process*. Scale Node horizontally and you fork N model
   copies in RAM. The FastAPI worker doesn't have this problem — it's already a
   shareable service — which is the stronger pattern if multi-process is on the
   horizon.

4. **Disk round-trips per request.** stdio path: Node writes `.raw` → Python
   reads it → writes `.wav` → pipeline reads it. Fine at one user, wasteful at
   volume. An in-memory decode (feed the pipeline an `np.ndarray` directly)
   removes both files.

5. **No queue, backpressure, batching, autoscale, auth, or rate limiting.** All
   appropriate to omit for a localhost tool; all required before this is a
   service.

**Recommendation:** keep the stdio worker as the zero-friction default for the
single-user case, and treat the FastAPI worker as the seam you'd grow into a
real service — fix its blocking call, put a job queue and a batching worker pool
behind it, and the front-end contract above never has to change.
