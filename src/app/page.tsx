"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { SessionReport, SurahInfo, AyahNote } from "@/lib/types";

/** Which ASR backend the next /api/check call should target. */
type Backend = "stdio" | "fastapi";

const BACKEND_STORAGE_KEY = "hifz.backend";

function loadInitialBackend(): Backend {
  if (typeof window === "undefined") return "stdio";
  const stored = window.localStorage.getItem(BACKEND_STORAGE_KEY);
  return stored === "fastapi" ? "fastapi" : "stdio";
}

function routeFor(backend: Backend): string {
  return backend === "fastapi" ? "/api/check-fast" : "/api/check";
}

// What gets shared and where it points. Update SHARE_URL to your deployed app
// (or keep the repo link), and tweak SHARE_TEXT to taste.
const SHARE_URL = "https://github.com/foyzulkarim/hifz-tester";
const SHARE_TEXT =
  "Hifz Tester — recite a Quran range aloud and get word-level feedback on exactly where you slipped.";

// TODO: paste your Google Form link here to enable the Feedback button.
// While empty, the button renders disabled.
const FEEDBACK_URL = "https://forms.gle/Bz43wsNVWihxaBnC7";

/** Social targets for the Share popup. Each opens in a small window. */
const SHARE_TARGETS: Array<{ name: string; href: string }> = [
  { name: "LinkedIn", href: `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(SHARE_URL)}` },
  { name: "Facebook", href: `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(SHARE_URL)}` },
  { name: "X / Twitter", href: `https://twitter.com/intent/tweet?url=${encodeURIComponent(SHARE_URL)}&text=${encodeURIComponent(SHARE_TEXT)}` },
  { name: "WhatsApp", href: `https://wa.me/?text=${encodeURIComponent(`${SHARE_TEXT} ${SHARE_URL}`)}` },
];

/** Decode a recorded blob to mono PCM at 16 kHz (what the ASR expects). */
async function toMono16k(blob: Blob): Promise<Float32Array> {
  const arr = await blob.arrayBuffer();
  const AC: typeof AudioContext =
    window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const ctx = new AC();
  const decoded = await ctx.decodeAudioData(arr);
  const frames = Math.ceil(decoded.duration * 16000);
  const offline = new OfflineAudioContext(1, frames, 16000);
  const src = offline.createBufferSource();
  src.buffer = decoded;
  src.connect(offline.destination);
  src.start();
  const rendered = await offline.startRendering();
  await ctx.close();
  return rendered.getChannelData(0).slice();
}

function NoteLine({ note, originalWords }: { note: AyahNote; originalWords: string[] }) {
  const w = note.wordIndex !== null ? note.wordIndex + 1 : null;
  // Show the original diacritized word from the ayah text when available
  const expectedOriginal = note.wordIndex !== null && originalWords[note.wordIndex]
    ? originalWords[note.wordIndex]
    : note.expected;

  if (note.kind === "substitution") {
    return (
      <li>
        Word {w}: expected <span className="ar">{expectedOriginal}</span>, heard{" "}
        <span className="ar miss">{note.heard}</span>.
      </li>
    );
  }
  if (note.kind === "omission") {
    return (
      <li>
        Word {w}: <span className="ar">{expectedOriginal}</span> was skipped.
      </li>
    );
  }
  return (
    <li>
      Extra word recited: <span className="ar miss">{note.heard}</span>.
    </li>
  );
}

/** Render the ayah text with mistaken words highlighted in red. */
function AyahText({ text, notes }: { text: string; notes: AyahNote[] }) {
  const words = text.trim().split(/\s+/);
  const errorIndices = new Set(
    notes.filter((n) => n.wordIndex !== null).map((n) => n.wordIndex!)
  );

  return (
    <div className="arabic">
      {words.map((word, i) => (
        <span key={i}>
          <span className={errorIndices.has(i) ? "word-error" : undefined}>
            {word}
          </span>
          {i < words.length - 1 ? " " : ""}
        </span>
      ))}
    </div>
  );
}

export default function Home() {
  const [surahs, setSurahs] = useState<SurahInfo[]>([]);
  const [surah, setSurah] = useState(1);
  const [from, setFrom] = useState(1);
  const [to, setTo] = useState(7);
  const [threshold, setThreshold] = useState(0.5);

  const [recording, setRecording] = useState(false);
  const [samples, setSamples] = useState<Float32Array | null>(null);
  const [busy, setBusy] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [report, setReport] = useState<SessionReport | null>(null);
  const [pendingReport, setPendingReport] = useState<SessionReport | null>(null);
  const [previewTranscript, setPreviewTranscript] = useState("");
  const [error, setError] = useState("");
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [recordTime, setRecordTime] = useState(0);
  const [shareOpen, setShareOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  // const [backend, setBackend] = useState<Backend>(loadInitialBackend);
  const backend: Backend = 'fastapi';

  useEffect(() => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(BACKEND_STORAGE_KEY, backend);
    }
  }, [backend]);

  const activeReport = report ?? pendingReport;
  const nextWord = activeReport?.nextWord;

  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const MAX_RECORD_SECONDS = 60;

  useEffect(() => {
    return () => {
      if (audioUrl) URL.revokeObjectURL(audioUrl);
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [audioUrl]);

  useEffect(() => {
    // Test-only hook: allows Playwright to inject a mock report without audio.
    // Gated to non-production so the prod bundle doesn't carry a state-mutation
    // escape hatch. Dev (npm run dev) and Playwright both see the hook; the
    // production build drops the branch entirely.
    if (process.env.NODE_ENV === "production") return;
    if (typeof window !== "undefined" && (window as unknown as Record<string, unknown>).__testReport) {
      setSamples(new Float32Array(1));
      setReport((window as unknown as Record<string, unknown>).__testReport as SessionReport);
    }
  }, []);

  const verseCount = useMemo(
    () => surahs.find((s) => s.id === surah)?.verses ?? 7,
    [surahs, surah],
  );

  const currentSurah = useMemo(
    () => surahs.find((s) => s.id === surah),
    [surahs, surah],
  );

  useEffect(() => {
    fetch("/api/surahs")
      .then((r) => r.json())
      .then((list: SurahInfo[]) => setSurahs(list))
      .catch(() => setError("Could not load the surah list."));
  }, []);

  function onSurahChange(id: number) {
    const vc = surahs.find((s) => s.id === id)?.verses ?? 7;
    setSurah(id);
    setFrom(1);
    setTo(Math.min(vc, 7));
    setReport(null);
  }

  async function startRecording() {
    setError("");
    setReport(null);
    setPendingReport(null);
    setPreviewTranscript("");
    setAudioUrl(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream);
      chunksRef.current = [];
      rec.ondataavailable = (e) => e.data.size && chunksRef.current.push(e.data);
      rec.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunksRef.current, { type: rec.mimeType });
        setAudioUrl(URL.createObjectURL(blob));
        try {
          const decodedSamples = await toMono16k(blob);
          setSamples(decodedSamples);
          // Auto-transcribe so the user sees the Arabic text immediately
          setTranscribing(true);
          const autoReport = await runCheck(decodedSamples);
          if (autoReport) {
            setPreviewTranscript(autoReport.transcript);
            setPendingReport(autoReport);
          }
          setTranscribing(false);
        } catch {
          setError("Could not process the recording. Try again.");
          setTranscribing(false);
        }
      };
      rec.start();
      recorderRef.current = rec;
      setRecording(true);
      setRecordTime(0);
      timerRef.current = setInterval(() => {
        setRecordTime((t) => {
          if (t + 1 >= MAX_RECORD_SECONDS) {
            stopRecording();
            return t + 1;
          }
          return t + 1;
        });
      }, 1000);
    } catch {
      setError("Microphone access was denied or unavailable.");
    }
  }

  function stopRecording() {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    recorderRef.current?.stop();
    setRecording(false);
  }

  async function runCheck(audioSamples: Float32Array): Promise<SessionReport | null> {
    const qs = new URLSearchParams({
      surah: String(surah),
      from: String(from),
      to: String(to),
      threshold: String(threshold),
    });
    const res = await fetch(`${routeFor(backend)}?${qs}`, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: new Blob([new Uint8Array(audioSamples.buffer as ArrayBuffer)]),
    });
    const data = await res.json();
    if (!res.ok) {
      setError(data.error ?? "Something went wrong.");
      return null;
    }
    return data as SessionReport;
  }

  async function check() {
    if (!samples) return;
    // If the pending report matches the current range, show it instantly
    if (
      pendingReport &&
      pendingReport.surah === surah &&
      pendingReport.fromAyah === from &&
      pendingReport.toAyah === to
    ) {
      setReport(pendingReport);
      return;
    }
    setBusy(true);
    setError("");
    setReport(null);
    try {
      const freshReport = await runCheck(samples);
      if (freshReport) setReport(freshReport);
    } catch {
      setError("Request failed. Is the dev server running?");
    } finally {
      setBusy(false);
    }
  }

  // Close the share popup on Escape.
  useEffect(() => {
    if (!shareOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setShareOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [shareOpen]);

  function openShare(href: string) {
    window.open(href, "_blank", "noopener,noreferrer,width=600,height=540");
  }

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(SHARE_URL);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard may be unavailable (e.g. non-secure context); ignore.
    }
  }

  return (
    <main className="wrap">
      <header className="masthead">
        <h1>Hifz Tester</h1>
        <p>Recite a range aloud. It listens, then tells you exactly where you slipped.</p>
        <div className="masthead-actions">
          <button className="btn-ghost btn-sm" onClick={() => setShareOpen(true)}>
            Share
          </button>
          {FEEDBACK_URL ? (
            <a className="btn-ghost btn-sm" href={FEEDBACK_URL} target="_blank" rel="noopener noreferrer">
              Feedback
            </a>
          ) : (
            <button className="btn-ghost btn-sm" disabled title="Feedback form link coming soon">
              Feedback
            </button>
          )}
        </div>
      </header>

      <section className="panel stack">
        <div className="row range">
          <div>
            <label>Surah</label>
            <select value={surah} onChange={(e) => onSurahChange(Number(e.target.value))}>
              {surahs.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.id}. {s.name} · {s.meaning}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label>From ayah</label>
            <select
              value={from}
              onChange={(e) => {
                const v = Number(e.target.value);
                setFrom(v);
                if (v > to) setTo(v);
              }}
            >
              {Array.from({ length: verseCount }, (_, i) => i + 1).map((n) => (
                <option key={n} value={n}>{n}</option>
              ))}
            </select>
          </div>
          <div>
            <label>To ayah</label>
            <select
              value={to}
              onChange={(e) => {
                const v = Number(e.target.value);
                setTo(v);
                if (v < from) setFrom(v);
              }}
            >
              {Array.from({ length: verseCount }, (_, i) => i + 1).map((n) => (
                <option key={n} value={n}>{n}</option>
              ))}
            </select>
          </div>
        </div>

        <div className="actions">
          {!recording ? (
            <button className="btn-rec" onClick={startRecording} disabled={busy || transcribing}>
              ● Record recitation
            </button>
          ) : (
            <button className="btn-rec recording" onClick={stopRecording}>
              ■ Stop {recordTime > 0 && `(${recordTime}s / ${MAX_RECORD_SECONDS}s)`}
            </button>
          )}
          <button className="btn-primary" onClick={check} disabled={!samples || busy || transcribing || recording}>
            {busy ? "Listening…" : "Check recitation"}
          </button>
          {/* <div className="backend-toggle" role="group" aria-label="ASR backend">
            <span className="backend-toggle-label">Model:</span>
            <button
              type="button"
              className={backend === "stdio" ? "btn-primary backend-btn" : "btn-ghost backend-btn"}
              onClick={() => setBackend("stdio")}
              disabled={busy || transcribing || recording}
              title="tarteel-ai/whisper-base-ar-quran — smaller, faster inference, lower accuracy on melodic recitation"
            >
              fast
            </button>
            <button
              type="button"
              className={backend === "fastapi" ? "btn-primary backend-btn" : "btn-ghost backend-btn"}
              onClick={() => setBackend("fastapi")}
              disabled={busy || transcribing || recording}
              title="MaddoggProduction/whisper-l-v3-turbo-quran-lora — larger, slower inference, outputs native tashkeel, higher accuracy"
            >
              slow
            </button>
          </div> */}
          {recording && (
            <span className="hint">{MAX_RECORD_SECONDS - recordTime}s remaining</span>
          )}
          {samples && !recording && !busy && !transcribing && !previewTranscript && (
            <span className="hint">Recording ready.</span>
          )}
          {transcribing && <span className="hint">Transcribing…</span>}
        </div>

        {audioUrl && !recording && (
          <div className="playback">
            <label>Playback your recording</label>
            <audio ref={audioRef} controls src={audioUrl} preload="metadata" />
          </div>
        )}

        {previewTranscript && !report && (
          <div className="transcript">
            Heard (ASR — plain text, no diacritics):{" "}
            <span className="ar">{previewTranscript}</span>
          </div>
        )}

        {error && <div className="error">{error}</div>}
      </section>

      {report && (
        <section>
          <div className={`summary ${report.allClean ? "clean" : "flagged"}`}>
            {report.allClean ? "✓ " : "⚠ "}{report.summary}
          </div>

          {report.transcript && (
            <div className="transcript">
              Heard (ASR — plain text, no diacritics):{" "}
              <span className="ar">{report.transcript}</span>
            </div>
          )}

          {currentSurah && (
            <div className="report-head">
              <span className="surah-ar">{currentSurah.nameArabic}</span>
              <span className="surah-en">{currentSurah.name} · {currentSurah.meaning}</span>
              <span className={`revelation-badge ${currentSurah.revelationType?.toLowerCase()}`}>
                {currentSurah.revelationType}
              </span>
              {/* <span className="backend-tag" title={`Last check used ${routeFor(backend)}`}>
                via {backend === "fastapi" ? "slow" : "fast"}
              </span> */}
            </div>
          )}

          {report.ayahs.map((a) => {
            const originalWords = a.text.trim().split(/\s+/);
            return (
              <article key={a.ayah} className={`ayah ${a.clean ? "clean" : "flagged"}`}>
                <div className="ayah-head">
                  <span className={`dot ${a.clean ? "clean" : "flagged"}`} />
                  Ayah {a.ayah} {a.clean ? "· clean" : "· needs review"}
                </div>
                <AyahText text={a.text} notes={a.notes} />
                {a.translation && (
                  <div className="ayah-translation">{a.translation}</div>
                )}
                {a.transliteration && (
                  <div
                    className="ayah-transliteration"
                    // Input is server-sanitized at load time by sanitizeTranslit(),
                    // which allowlists tag names and rejects attributes.
                    dangerouslySetInnerHTML={{ __html: a.transliteration }}
                  />
                )}
                {!a.clean && (
                  <ul className="notes">
                    {a.notes.map((n, i) => (
                      <NoteLine key={i} note={n} originalWords={originalWords} />
                    ))}
                  </ul>
                )}
              </article>
            );
          })}
        </section>
      )}

      <details>
        <summary>Stuck? Show next word (luqma)</summary>
        <div className="adv panel">
          {nextWord ? (
            <div className="actions" style={{ flexWrap: "nowrap" }}>
              <span className="hint">Next word:</span>
              <span className="big-ar">{nextWord.text}</span>
              {nextWord.transliteration && (
                <span
                  className="luqma-translit"
                  dangerouslySetInnerHTML={{ __html: nextWord.transliteration }}
                />
              )}
              <span className="hint">
                Ayah {nextWord.ayah}, word {nextWord.wordIndex + 1}
              </span>
            </div>
          ) : activeReport ? (
            <p className="hint">You reached the end of the selected range.</p>
          ) : (
            <p className="hint">Recite first — the next word appears here automatically.</p>
          )}
        </div>
      </details>

      <details>
        <summary>Tuning</summary>
        <div className="adv panel">
          <label>Match tolerance — {threshold.toFixed(2)}</label>
          <div className="slider-row">
            <input type="range" min={0.5} max={0.98} step={0.01} value={threshold}
              onChange={(e) => setThreshold(Number(e.target.value))} />
          </div>
          <p className="hint" style={{ marginTop: 10 }}>
            Higher = stricter (more slips caught, more false alarms). Lower = more
            forgiving of the recognizer mishearing a correct word. Tune on your own voice.
          </p>
        </div>
      </details>

      {shareOpen && (
        <div className="modal-backdrop" role="presentation" onClick={() => setShareOpen(false)}>
          <div
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-label="Share Hifz Tester"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-head">
              <h2>Share</h2>
              <button className="modal-close" onClick={() => setShareOpen(false)} aria-label="Close">
                ×
              </button>
            </div>
            <div className="share-grid">
              {SHARE_TARGETS.map((t) => (
                <button key={t.name} className="btn-ghost share-item" onClick={() => openShare(t.href)}>
                  {t.name}
                </button>
              ))}
            </div>
            <button className="btn-ghost btn-block" onClick={copyLink}>
              {copied ? "Link copied ✓" : "Copy link"}
            </button>
          </div>
        </div>
      )}
    </main>
  );
}
