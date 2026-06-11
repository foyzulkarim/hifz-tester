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

export default function Home() {
  const [surahs, setSurahs] = useState<SurahInfo[]>([]);
  const [surah, setSurah] = useState(1);
  const [from, setFrom] = useState(1);
  const [to, setTo] = useState(7);
  const [threshold, setThreshold] = useState(0.5);

  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [referenceVerses, setReferenceVerses] = useState<ReferenceVerse[]>([]);
  // Hidden by default so the reciter can't peek at the text right before
  // (or between) memorization attempts; revealing is a deliberate choice.
  const [showReference, setShowReference] = useState(false);
  const [report, setReport] = useState<SessionReport | null>(null);
  const [error, setError] = useState("");
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [recordTime, setRecordTime] = useState(0);
  const [shareOpen, setShareOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  const nextWord = report?.nextWord;

  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Each new recording bumps the generation so a stale in-flight
  // transcription can't overwrite the transcript of a newer take.
  const transcribeGenRef = useRef(0);
  // In-flight transcription; `check()` awaits this if the user clicks
  // "Check recitation" before ASR finishes.
  const transcribePromiseRef = useRef<Promise<string | null> | null>(null);
  // Whether the user has run a check yet; range/threshold changes only
  // auto-re-verify after the first explicit check.
  const checkedRef = useRef(false);
  const rangeInitRef = useRef(true);

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
      const injected = (window as unknown as Record<string, unknown>).__testReport as SessionReport;
      setTranscript(injected.transcript || "test");
      setReport(injected);
      checkedRef.current = true;
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

  // After the first check, changing the range or tolerance re-verifies the
  // cached transcript instantly -- verification is text-only, no ASR re-run.
  useEffect(() => {
    if (rangeInitRef.current) {
      rangeInitRef.current = false;
      return;
    }
    setReport(null);
    if (!checkedRef.current || !transcript) return;
    let cancelled = false;
    verifyTranscript(transcript).then((r) => {
      if (!cancelled && r) setReport(r);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [surah, from, to, threshold]);

  function onSurahChange(id: number) {
    const vc = surahs.find((s) => s.id === id)?.verses ?? 7;
    setSurah(id);
    setFrom(1);
    setTo(Math.min(vc, 7));
  }

  async function startRecording() {
    setError("");
    setReport(null);
    setTranscript("");
    setAudioUrl(null);
    setShowReference(false); // re-hide the text for the new attempt
    // A fresh take must be checked explicitly; auto-re-verify on range
    // change only kicks in after THIS transcript has been checked once.
    checkedRef.current = false;
    transcribePromiseRef.current = null;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream);
      chunksRef.current = [];
      rec.ondataavailable = (e) => e.data.size && chunksRef.current.push(e.data);
      rec.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunksRef.current, { type: rec.mimeType });
        setAudioUrl(URL.createObjectURL(blob));
        // Auto-transcribe in the background while the user picks the range;
        // by the time they click "Check recitation" the transcript is ready.
        const gen = ++transcribeGenRef.current;
        setTranscribing(true);
        transcribePromiseRef.current = (async (): Promise<string | null> => {
          try {
            const samples = await toMono16k(blob);
            const text = await transcribeSamples(samples, gen);
            if (transcribeGenRef.current !== gen) return null; // superseded
            if (text !== null) {
              if (text.trim()) {
                setTranscript(text);
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
      if (freshReport) {
        setReport(freshReport);
        checkedRef.current = true;
      }
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

      {/* Step 1: record from memory -- nothing to peek at yet. */}
      <section className="panel stack">
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

        {error && <div className="error">{error}</div>}
      </section>

      {/* Step 2: pick the range, see the actual Quran text, then check. */}
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

        {/* The reference text (what SHOULD be recited). Collapsed by default
            so reciting stays a memory test; gone once a report renders --
            the report repeats these verses with mistakes marked. */}
        {referenceVerses.length > 0 && !report && (
          <div className="stack">
            <div className="actions">
              <label style={{ margin: 0 }}>
                Actual Quran text — ayah {from}{to !== from ? `–${to}` : ""} (what should be recited)
              </label>
              <button
                className="btn-ghost btn-sm"
                onClick={() => setShowReference((s) => !s)}
              >
                {showReference ? "Hide text" : "Show text"}
              </button>
            </div>
            {showReference ? (
              referenceVerses.map((v) => (
                <article key={v.ayah} className="ayah">
                  <div className="ayah-head">Ayah {v.ayah}</div>
                  <div className="arabic">{v.text}</div>
                  {v.translation && (
                    <div className="ayah-translation">{v.translation}</div>
                  )}
                </article>
              ))
            ) : (
              <span className="hint">
                Hidden so you recite from memory. Reveal only to double-check the range.
              </span>
            )}
          </div>
        )}

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
          ) : report ? (
            <p className="hint">You reached the end of the selected range.</p>
          ) : (
            <p className="hint">Recite and check first — the next word appears here automatically.</p>
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
