"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { SessionReport, SurahInfo, AyahNote } from "@/lib/types";

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

/** The reference verses /api/ayahs returns for the selected range. */
interface ReferenceVerse {
  ayah: number;
  text: string;
  translation?: string;
}

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

function AyahSelect({
  label, value, verseCount, previewText, onChange,
}: {
  label: string; value: number; verseCount: number; previewText?: string;
  onChange: (v: number) => void;
}) {
  return (
    <div>
      <label>{label}</label>
      <select value={value} onChange={(e) => onChange(Number(e.target.value))}>
        {Array.from({ length: verseCount }, (_, i) => i + 1).map((n) => (
          <option key={n} value={n}>{n}</option>
        ))}
      </select>
      {previewText && <div className="arabic boundary-ayah">{previewText}</div>}
    </div>
  );
}

export default function Home() {
  const [surahs, setSurahs] = useState<SurahInfo[]>([]);
  const [surah, setSurah] = useState(1);
  const [from, setFrom] = useState(1);
  const [to, setTo] = useState(1);
  const [threshold, setThreshold] = useState(0.5);

  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [referenceVerses, setReferenceVerses] = useState<ReferenceVerse[]>([]);
  const [report, setReport] = useState<SessionReport | null>(null);
  const [error, setError] = useState("");
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [recordTime, setRecordTime] = useState(0);
  const [shareOpen, setShareOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [detectedRange, setDetectedRange] = useState<{ from: number; to: number } | null>(null);
  const autoDetected = detectedRange !== null && from === detectedRange.from && to === detectedRange.to;

  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const blobRef = useRef<Blob | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Each new recording bumps the generation so a stale in-flight
  // transcription can't overwrite the transcript of a newer take.
  const transcribeGenRef = useRef(0);
  // In-flight transcription; `check()` awaits this if the user clicks
  // "Check recitation" before ASR finishes.
  const transcribePromiseRef = useRef<Promise<string | null> | null>(null);
  const rangeInitRef = useRef(true);

  const MAX_RECORD_SECONDS = 60;

  // ── Install banner state ──────────────────────────────────────────
  const [showInstallBanner, setShowInstallBanner] = useState(false);
  const [isIOS, setIsIOS] = useState(false);
  const [deferredPrompt, setDeferredPrompt] = useState<Event | null>(null);

  useEffect(() => {
    // Already installed as PWA?
    const standalone =
      (typeof window !== "undefined" && "standalone" in window.navigator && (window.navigator as any).standalone === true) ||
      window.matchMedia("(display-mode: standalone)").matches;
    if (standalone) return;

    // Dismissed before?
    if (typeof window !== "undefined" && localStorage.getItem("hifz-install-dismissed") === "1") return;

    // Mobile detection
    const ua = navigator.userAgent;
    const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(ua) || window.innerWidth < 768;
    if (!isMobile) return;

    const ios = /iPad|iPhone|iPod/.test(ua) || (ua.includes("Mac") && "ontouchend" in document);
    setIsIOS(ios);

    if (ios) {
      const t = setTimeout(() => setShowInstallBanner(true), 2000);
      return () => clearTimeout(t);
    }

    // Android / Chrome: wait for beforeinstallprompt
    const handler = (e: Event) => {
      e.preventDefault();
      setDeferredPrompt(e);
      setShowInstallBanner(true);
    };
    window.addEventListener("beforeinstallprompt", handler);
    return () => window.removeEventListener("beforeinstallprompt", handler);
  }, []);

  async function handleInstallClick() {
    if (isIOS) return;
    if (!deferredPrompt) return;
    const p = deferredPrompt as any;
    p.prompt();
    const { outcome } = await p.userChoice;
    if (outcome === "accepted") setShowInstallBanner(false);
    setDeferredPrompt(null);
  }

  async function handleShareClick() {
    if (typeof navigator === "undefined" || !navigator.share) return;
    try {
      await navigator.share({
        title: "Hifz Tester",
        text: "Hifz Tester — a quiet listening teacher for Quran memorization.",
        url: window.location.href,
      });
    } catch {
      // User cancelled — ignore
    }
  }

  function dismissInstallBanner() {
    setShowInstallBanner(false);
    localStorage.setItem("hifz-install-dismissed", "1");
  }

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
      const injected = (window as unknown as Record<string, unknown>).__testReport as SessionReport;
      setTranscript(injected.transcript || "test");
      setReport(injected);
    }
  }, []);

  const currentSurah = useMemo(
    () => surahs.find((s) => s.id === surah),
    [surahs, surah],
  );
  const verseCount = currentSurah?.verses ?? 1;

  useEffect(() => {
    fetch("/api/surahs")
      .then((r) => r.json())
      .then((list: SurahInfo[]) => setSurahs(list))
      .catch(() => setError("Could not load the surah list."));
  }, []);

  // Load the actual Quran text for the selected range -- the reference of
  // what SHOULD be recited, distinct from the ASR transcript of what WAS.
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/ayahs?surah=${surah}&from=${from}&to=${to}`)
      .then((r) => r.json())
      .then((data) => {
        if (!cancelled && Array.isArray(data)) setReferenceVerses(data);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [surah, from, to]);

  // Changing the range or tolerance invalidates the current verdict: clear
  // it so the user can re-check the same recording against the new selection
  // (verification reuses the cached transcript -- no ASR re-run).
  useEffect(() => {
    if (rangeInitRef.current) {
      rangeInitRef.current = false;
      return;
    }
    setReport(null);
    setError("");
  }, [surah, from, to, threshold]);

  function onSurahChange(id: number) {
    setSurah(id);
    setFrom(1);
    setTo(1);
    setDetectedRange(null);
  }

  async function detectRange(transcriptText: string) {
    try {
      const res = await fetch("/api/detect-range", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ surah, transcript: transcriptText }),
      });
      const data = await res.json();
      if (!res.ok) return;
      const { from: detectedFrom, to: detectedTo } = data as { from: number | null; to: number | null };
      if (detectedFrom !== null && detectedTo !== null) {
        setFrom(detectedFrom);
        setTo(detectedTo);
        setDetectedRange({ from: detectedFrom, to: detectedTo });
      }
    } catch {
      // Silent fail — auto-detection is a convenience, not a hard requirement.
    }
  }

  function runTranscription(blob: Blob) {
    const gen = ++transcribeGenRef.current;
    setTranscribing(true);
    setError("");
    transcribePromiseRef.current = (async (): Promise<string | null> => {
      try {
        const samples = await toMono16k(blob);
        const text = await transcribeSamples(samples, gen);
        if (transcribeGenRef.current !== gen) return null; // superseded
        if (text !== null) {
          if (text.trim()) {
            setTranscript(text);
            detectRange(text);
          } else {
            setError("Nothing was transcribed — the recording may be silent. Try again.");
          }
        }
        return text;
      } catch {
        if (transcribeGenRef.current === gen) {
          setError("Could not process the recording. Try again.");
        }
        return null;
      } finally {
        if (transcribeGenRef.current === gen) setTranscribing(false);
      }
    })();
  }

  function retryTranscription() {
    if (!blobRef.current) return;
    setTranscript("");
    runTranscription(blobRef.current);
  }

  async function startRecording() {
    setError("");
    setReport(null);
    setTranscript("");
    setAudioUrl(null);
    setFrom(1);
    setTo(1);
    setDetectedRange(null);
    transcribePromiseRef.current = null;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream);
      chunksRef.current = [];
      rec.ondataavailable = (e) => e.data.size && chunksRef.current.push(e.data);
      rec.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunksRef.current, { type: rec.mimeType });
        blobRef.current = blob;
        setAudioUrl(URL.createObjectURL(blob));
        // Auto-transcribe in the background while the user picks the range;
        // by the time they click "Check recitation" the transcript is ready.
        runTranscription(blob);
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

  async function transcribeSamples(audioSamples: Float32Array, gen: number): Promise<string | null> {
    const res = await fetch("/api/transcribe", {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: new Blob([new Uint8Array(audioSamples.buffer as ArrayBuffer)]),
    });
    const data = await res.json();
    if (!res.ok) {
      if (transcribeGenRef.current === gen) setError(data.error ?? "Transcription failed.");
      return null;
    }
    return data.transcript as string;
  }

  async function verifyTranscript(transcriptText: string): Promise<SessionReport | null> {
    const res = await fetch("/api/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ surah, from, to, threshold, transcript: transcriptText }),
    });
    const data = await res.json();
    if (!res.ok) {
      setError(data.error ?? "Something went wrong.");
      return null;
    }
    return data as SessionReport;
  }

  async function check() {
    setError("");
    setBusy(true);
    try {
      // If ASR is still chewing on the recording, wait for it instead of
      // re-running anything.
      let text = transcript;
      if (!text && transcribePromiseRef.current) {
        text = (await transcribePromiseRef.current) ?? "";
      }
      if (!text.trim()) return;
      const freshReport = await verifyTranscript(text);
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

      {showInstallBanner && (
        <div className="install-banner">
          <div className="install-banner-content">
            <span>
              {isIOS
                ? "Install this app to your home screen"
                : "Install this app for quick access from your home screen"}
            </span>
            <div className="install-banner-actions">
              {isIOS ? (
                <button className="btn-primary btn-sm" onClick={handleShareClick}>
                  Share
                </button>
              ) : (
                <button className="btn-primary btn-sm" onClick={handleInstallClick}>
                  Install
                </button>
              )}
              <button className="btn-ghost btn-sm" onClick={dismissInstallBanner}>
                Dismiss
              </button>
            </div>
          </div>
        </div>
      )}

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

      {/* Step 1: record from memory -- nothing to peek at yet. */}
      <section className="panel stack">
        <h2 className="card-title">1 — Record your recitation</h2>
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
        <div className="actions">
          {!recording ? (
            <button className="btn-rec" onClick={startRecording} disabled={busy}>
              ● Record recitation
            </button>
          ) : (
            <button className="btn-rec recording" onClick={stopRecording}>
              ■ Stop {recordTime > 0 && `(${recordTime}s / ${MAX_RECORD_SECONDS}s)`}
            </button>
          )}
          {recording && (
            <span className="hint">{MAX_RECORD_SECONDS - recordTime}s remaining</span>
          )}
          {transcribing && <span className="hint">Transcribing…</span>}
        </div>

        {audioUrl && !recording && (
          <div className="playback">
            <label>Playback your recording</label>
            <audio ref={audioRef} controls src={audioUrl} preload="metadata" />
          </div>
        )}

        {transcript && (
          <div className="transcript">
            Heard (ASR — plain text, no diacritics):{" "}
            <span className="ar">{transcript}</span>
          </div>
        )}

        {error && (
          <div>
            <div className="error">{error}</div>
            {audioUrl && !transcribing && (
              <button className="btn-ghost btn-sm" style={{ marginTop: 8 }} onClick={retryTranscription}>
                Retry transcription
              </button>
            )}
          </div>
        )}
      </section>

      {/* Step 2: confirm the range, then check. */}
      <section className="panel stack">
        <h2 className="card-title">2 — Verify range &amp; check</h2>
        {autoDetected && (
          <span className="hint auto-detected">
            Range auto-detected from your recitation. Adjust below if needed.
          </span>
        )}

        <AyahSelect
          label="From ayah"
          value={from}
          verseCount={verseCount}
          previewText={referenceVerses.find((v) => v.ayah === from)?.text}
          onChange={(v) => { setFrom(v); if (v > to) setTo(v); }}
        />

        <AyahSelect
          label="To ayah"
          value={to}
          verseCount={verseCount}
          previewText={referenceVerses.find((v) => v.ayah === to)?.text}
          onChange={(v) => { setTo(v); if (v < from) setFrom(v); }}
        />

        <div className="actions">
          <button
            className="btn-primary"
            onClick={check}
            disabled={(!transcript && !transcribing) || recording || busy}
          >
            {busy ? "Checking…" : "Check recitation"}
          </button>
          {!transcript && !transcribing && !recording && (
            <span className="hint">Record your recitation first.</span>
          )}
        </div>
      </section>

      {report && (
        <section>
          <div className={`summary ${report.allClean ? "clean" : "flagged"}`}>
            {report.allClean ? "✓ " : "⚠ "}{report.summary}
          </div>

          {currentSurah && (
            <div className="report-head">
              <span className="surah-ar">{currentSurah.nameArabic}</span>
              <span className="surah-en">{currentSurah.name} · {currentSurah.meaning}</span>
              <span className={`revelation-badge ${currentSurah.revelationType?.toLowerCase()}`}>
                {currentSurah.revelationType}
              </span>
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
                {a.heardText && (
                  <div className="ayah-heard">
                    <span className="ayah-heard-label">You recited:</span>
                    <span className="ar ayah-heard-text">{a.heardText}</span>
                  </div>
                )}
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
