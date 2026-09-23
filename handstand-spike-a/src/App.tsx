import { useCallback, useEffect, useRef, useState } from "react";
import {
  createPoseLandmarker,
  FrameSource,
  unrotate180,
  type DelegatePref,
  type Landmark,
  type LandmarkerHandle,
  type ModelVariant,
} from "./lib/pose";
import { drawStickFigure } from "./lib/skeleton";
import {
  flattenLandmarks,
  shareOrDownload,
  shareOrDownloadVideo,
  type FrameRecord,
  type LogEvent,
  type SpikeExport,
  type StorageSample,
  type TiltSample,
  type VideoRecordingInfo,
} from "./lib/export";
import { useCamera, type Facing } from "./hooks/useCamera";
import { useLevel } from "./hooks/useLevel";
import { useVideoRecorder } from "./hooks/useVideoRecorder";
import {
  discardSession,
  estimateStorage,
  listOrphanSessions,
  storeFromOrphan,
  finalizeSession,
  type OrphanSession,
} from "./lib/videoStore";
import { LevelIndicator } from "./components/LevelIndicator";

type Phase = "idle" | "leveling" | "recording" | "review";

type Settings = {
  facing: Facing;
  variant: ModelVariant;
  delegate: DelegatePref;
  maxSide: number; // longest side of the frame sent to the model; 0 = full resolution
  rotate180: boolean; // rotate frames 180° for inference so inverted poses look upright
  showPreview: boolean; // show the camera picture while recording (skeleton is always shown)
  bypassLevel: boolean; // desktop testing only
  recordVideo: boolean; // spike B: record + chunk the session video alongside the landmarks
};

const DEFAULTS: Settings = {
  facing: "environment",
  variant: "lite",
  delegate: "auto",
  maxSide: 640,
  rotate180: false,
  showPreview: true,
  bypassLevel: false,
  recordVideo: true,
};

type RecordingLog = {
  startPerf: number;
  frames: FrameRecord[];
  tiltSamples: TiltSample[];
  storageSamples: StorageSample[];
  events: LogEvent[];
  tiltAtStart: { roll: number; pitch: number } | null;
  infMsSum: number;
  infCount: number;
  poseFrames: number;
};

type VideoInfo = { blob: Blob; mimeType: string };

type Stats = { fps: number; avgMs: number; poseRate: number };

type ModelState =
  | { status: "loading" }
  | { status: "ready"; delegate: "GPU" | "CPU" }
  | { status: "error"; message: string };

const LAYOUT =
  "Each frame's lm array holds 33 MediaPipe landmarks as [x, y, z, visibility] in order, " +
  "x/y normalized 0-1 in the original camera frame (not mirrored, not rotated). t is ms since recording started.";

function formatTime(ms: number) {
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export default function App() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [settings, setSettings] = useState<Settings>(DEFAULTS);
  const [model, setModel] = useState<ModelState>({ status: "loading" });
  const [handle, setHandle] = useState<LandmarkerHandle | null>(null);
  const [stats, setStats] = useState<Stats>({ fps: 0, avgMs: 0, poseRate: 0 });
  const [elapsed, setElapsed] = useState(0);
  const [result, setResult] = useState<SpikeExport | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [videoInfo, setVideoInfo] = useState<VideoInfo | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [orphans, setOrphans] = useState<OrphanSession[]>([]);
  const [recoveryBusy, setRecoveryBusy] = useState(false);

  const camera = useCamera();
  // Green range: roll within ±1.5°, pitch (incline/decline) allowed up to ±26°.
  const level = useLevel(phase === "leveling", { toleranceDeg: 1.5, maxPitchDeg: 26 });
  const recorder = useVideoRecorder();
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // The detection loop reads these instead of React state, so it never re-subscribes.
  const settingsRef = useRef(settings);
  const phaseRef = useRef(phase);
  const logRef = useRef<RecordingLog | null>(null);
  const wakeRef = useRef<WakeLockSentinel | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  useEffect(() => { settingsRef.current = settings; }, [settings]);
  useEffect(() => { phaseRef.current = phase; }, [phase]);

  // ---- Crash recovery: find sessions still on disk from a previous run ---------------
  useEffect(() => {
    void listOrphanSessions().then(setOrphans);
  }, []);

  // ---- Object URL for the review-screen video preview, revoked on cleanup ------------
  useEffect(() => {
    if (!videoInfo) return;
    const url = URL.createObjectURL(videoInfo.blob);
    setVideoUrl(url);
    return () => {
      URL.revokeObjectURL(url);
      setVideoUrl(null);
    };
  }, [videoInfo]);

  // ---- Camera track ending unexpectedly (e.g. iOS killing the camera in background) --
  useEffect(() => {
    const track = camera.stream?.getVideoTracks()[0];
    if (!track) return;
    const onEnded = () => {
      const log = logRef.current;
      if (phaseRef.current === "recording" && log) {
        log.events.push({ t: Math.round(performance.now() - log.startPerf), type: "camera-track-ended" });
      }
      setNotice("The camera stopped unexpectedly (often from backgrounding the app for too long).");
    };
    track.addEventListener("ended", onEnded);
    return () => track.removeEventListener("ended", onEnded);
  }, [camera.stream]);

  const update = <K extends keyof Settings>(key: K, value: Settings[K]) =>
    setSettings((s) => ({ ...s, [key]: value }));

  // ---- Model loading -------------------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    let created: LandmarkerHandle | null = null;
    setModel({ status: "loading" });
    setHandle(null);
    createPoseLandmarker(settings.variant, settings.delegate)
      .then((h) => {
        if (cancelled) {
          h.landmarker.close();
          return;
        }
        created = h;
        setHandle(h);
        setModel({ status: "ready", delegate: h.delegate });
      })
      .catch((err) => {
        if (!cancelled) {
          setModel({
            status: "error",
            message: `${err?.message ?? err}. Did the model download finish? Run npm run setup-assets.`,
          });
        }
      });
    return () => {
      cancelled = true;
      created?.landmarker.close();
    };
  }, [settings.variant, settings.delegate]);

  // ---- Wake lock -----------------------------------------------------------------------
  const acquireWake = useCallback(async () => {
    try {
      wakeRef.current = (await navigator.wakeLock?.request("screen")) ?? null;
    } catch {
      wakeRef.current = null; // not supported, or denied; not fatal
    }
  }, []);
  const releaseWake = useCallback(() => {
    wakeRef.current?.release().catch(() => {});
    wakeRef.current = null;
  }, []);

  // Wake locks drop when the page is hidden; also log visibility changes during recording.
  useEffect(() => {
    const onVisibility = () => {
      const p = phaseRef.current;
      const log = logRef.current;
      if (p === "recording" && log) {
        log.events.push({ t: Math.round(performance.now() - log.startPerf), type: document.visibilityState });
      }
      if (document.visibilityState === "visible" && (p === "leveling" || p === "recording")) {
        void acquireWake();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [acquireWake]);

  // ---- Detection + drawing loop --------------------------------------------------------
  useEffect(() => {
    const video = camera.videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || camera.status !== "live" || !handle) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const { landmarker } = handle;
    const source = new FrameSource();
    const useRvfc = "requestVideoFrameCallback" in video;
    const acc = { frames: 0, msSum: 0, pose: 0, since: performance.now() };
    let cancelled = false;
    let lastTs = 0;
    let scheduled = 0;

    const schedule = () => {
      if (cancelled) return;
      scheduled = useRvfc ? video.requestVideoFrameCallback(tick) : requestAnimationFrame(tick);
    };

    const tick = () => {
      if (cancelled) return;
      const w = video.videoWidth;
      const h = video.videoHeight;

      if (w && h && video.readyState >= 2) {
        if (canvas.width !== w || canvas.height !== h) {
          canvas.width = w;
          canvas.height = h;
        }
        const s = settingsRef.current;
        const now = performance.now();
        const ts = Math.max(Math.round(now), lastTs + 1); // MediaPipe needs strictly increasing ms
        lastTs = ts;

        let lm: Landmark[] | null = null;
        const t0 = performance.now();
        try {
          const input = source.prepare(video, s.rotate180, s.maxSide);
          const res = landmarker.detectForVideo(input, ts);
          const first = res.landmarks[0];
          if (first) {
            const mapped = first.map((p) => ({ x: p.x, y: p.y, z: p.z, visibility: p.visibility ?? 0 }));
            lm = s.rotate180 ? unrotate180(mapped) : mapped;
          }
        } catch (err) {
          console.error("Pose detection failed", err);
        }
        const ms = performance.now() - t0;

        ctx.clearRect(0, 0, w, h);
        if (lm) drawStickFigure(ctx, lm, w, h);

        const log = logRef.current;
        if (phaseRef.current === "recording" && log) {
          log.frames.push({
            t: Math.round((now - log.startPerf) * 10) / 10,
            lm: lm ? flattenLandmarks(lm) : null,
          });
          log.infMsSum += ms;
          log.infCount += 1;
          if (lm) log.poseFrames += 1;
        }

        acc.frames += 1;
        acc.msSum += ms;
        if (lm) acc.pose += 1;
        if (now - acc.since >= 500) {
          setStats({
            fps: acc.frames / ((now - acc.since) / 1000),
            avgMs: acc.msSum / acc.frames,
            poseRate: acc.pose / acc.frames,
          });
          acc.frames = 0;
          acc.msSum = 0;
          acc.pose = 0;
          acc.since = now;
        }
      }
      schedule();
    };

    schedule();
    return () => {
      cancelled = true;
      if (useRvfc) video.cancelVideoFrameCallback(scheduled);
      else cancelAnimationFrame(scheduled);
    };
  }, [camera.status, camera.videoRef, handle]);

  // ---- Recording timer + tilt sampling ------------------------------------------------
  useEffect(() => {
    if (phase !== "recording") return;
    const id = window.setInterval(() => {
      const log = logRef.current;
      if (!log) return;
      const t = Math.round(performance.now() - log.startPerf);
      setElapsed(t);
      if (level.hasData || level.latest.current.roll !== 0) {
        log.tiltSamples.push({ t, roll: round2(level.latest.current.roll), pitch: round2(level.latest.current.pitch) });
      }
    }, 200);
    return () => window.clearInterval(id);
  }, [phase, level.hasData, level.latest]);

  // ---- Storage sampling (spike B): chunk/byte counts + storage quota over time --------
  useEffect(() => {
    if (phase !== "recording" || !settings.recordVideo) return;
    const id = window.setInterval(() => {
      const log = logRef.current;
      if (!log) return;
      const t = Math.round(performance.now() - log.startPerf);
      const s = recorder.statsRef.current;
      void estimateStorage().then((est) => {
        log.storageSamples.push({
          t,
          chunkCount: s.chunkCount,
          totalBytes: s.totalBytes,
          quotaUsage: est?.usage ?? null,
          quotaTotal: est?.quota ?? null,
        });
      });
      // Watchdog: no new chunk in 3x the timeslice suggests the recorder stalled (e.g. the
      // camera track paused in the background without firing a track "ended" event).
      if (s.lastChunkAt != null && Date.now() - s.lastChunkAt > 6000) {
        log.events.push({ t, type: "recorder-stalled" });
      }
    }, 2000);
    return () => window.clearInterval(id);
  }, [phase, settings.recordVideo, recorder.statsRef]);

  // ---- Actions -------------------------------------------------------------------------
  const startSession = async () => {
    setNotice(null);
    // Must be first: iOS only shows the motion permission prompt inside a tap handler.
    if (!settings.bypassLevel) await level.request();
    setPhase("leveling");
    await camera.start(settings.facing);
    await acquireWake();
  };

  const startRecording = async () => {
    logRef.current = {
      startPerf: performance.now(),
      frames: [],
      tiltSamples: [],
      storageSamples: [],
      events: [],
      tiltAtStart: level.hasData ? { roll: round2(level.latest.current.roll), pitch: round2(level.latest.current.pitch) } : null,
      infMsSum: 0,
      infCount: 0,
      poseFrames: 0,
    };
    setElapsed(0);
    setVideoInfo(null);
    setPhase("recording");

    if (settings.recordVideo && camera.stream) {
      const id = crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      sessionIdRef.current = id;
      try {
        await recorder.start(camera.stream, id);
      } catch (err) {
        sessionIdRef.current = null;
        setNotice(`Video recording didn't start (${(err as Error).message}). Landmarks are still being recorded.`);
      }
    }
  };

  const stopRecording = async () => {
    const log = logRef.current;
    if (!log) return;
    const durationMs = Math.round(performance.now() - log.startPerf);

    let videoRecording: VideoRecordingInfo = null;
    if (sessionIdRef.current) {
      try {
        const finalized = await recorder.stop();
        if (finalized) {
          setVideoInfo({ blob: finalized.blob, mimeType: finalized.mimeType });
          videoRecording = {
            mimeType: finalized.mimeType,
            backend: finalized.backend,
            chunkCount: finalized.chunkCount,
            totalBytes: finalized.totalBytes,
          };
        }
      } catch (err) {
        setNotice(`Could not assemble the recorded video: ${(err as Error).message}`);
      }
      sessionIdRef.current = null;
    }

    setResult({
      schema: "handstand-spike-a/v2",
      createdAt: new Date().toISOString(),
      userAgent: navigator.userAgent,
      layout: LAYOUT,
      video: { width: camera.size.width, height: camera.size.height, facing: settings.facing, recording: videoRecording },
      settings: { ...settings, model: model.status === "ready" ? model.delegate : null },
      tiltAtStart: log.tiltAtStart,
      tiltSamples: log.tiltSamples,
      storageSamples: log.storageSamples,
      events: log.events,
      summary: {
        durationMs,
        frames: log.frames.length,
        poseFrames: log.poseFrames,
        avgInferenceMs: log.infCount ? round2(log.infMsSum / log.infCount) : 0,
      },
      frames: log.frames,
    });
    logRef.current = null;
    camera.stop();
    releaseWake();
    setPhase("review");
  };

  const cancelSession = () => {
    logRef.current = null;
    camera.stop();
    releaseWake();
    setPhase("idle");
  };

  const save = async () => {
    if (!result) return;
    try {
      await shareOrDownload(result);
    } catch (err) {
      setNotice(`Could not save the file: ${(err as Error).message}`);
    }
  };

  const saveVideo = async () => {
    if (!videoInfo) return;
    try {
      await shareOrDownloadVideo(videoInfo.blob, videoInfo.mimeType);
    } catch (err) {
      setNotice(`Could not save the video: ${(err as Error).message}`);
    }
  };

  const recoverOrphan = async (orphan: OrphanSession) => {
    setRecoveryBusy(true);
    try {
      const store = storeFromOrphan(orphan);
      const finalized = await finalizeSession(store);
      await shareOrDownloadVideo(finalized.blob, orphan.mimeType);
      await discardSession(store);
      setOrphans((list) => list.filter((o) => o.id !== orphan.id));
    } catch (err) {
      setNotice(`Could not recover that session: ${(err as Error).message}`);
    } finally {
      setRecoveryBusy(false);
    }
  };

  const discardOrphan = async (orphan: OrphanSession) => {
    setRecoveryBusy(true);
    try {
      await discardSession(storeFromOrphan(orphan));
      setOrphans((list) => list.filter((o) => o.id !== orphan.id));
    } catch (err) {
      setNotice(`Could not discard that session: ${(err as Error).message}`);
    } finally {
      setRecoveryBusy(false);
    }
  };

  // ---- Derived UI state ---------------------------------------------------------------
  const cameraLive = camera.status === "live";
  const ready = model.status === "ready";
  const canRecord = cameraLive && ready && (settings.bypassLevel || level.isLevel);
  const stageVisible = phase === "leveling" || phase === "recording";
  const previewVisible = phase !== "recording" || settings.showPreview;
  const ratio =
    camera.size.width && camera.size.height ? `${camera.size.width} / ${camera.size.height}` : "9 / 16";

  return (
    <main className="app">
      <header className="top">
        <h1>Handstand spike A</h1>
        <span className={`pill ${model.status}`}>
          {model.status === "loading" && "Loading model…"}
          {model.status === "ready" && `Model ready (${model.delegate})`}
          {model.status === "error" && "Model failed"}
        </span>
      </header>

      {model.status === "error" && <p className="msg bad">{model.message}</p>}
      {notice && <p className="msg warn">{notice}</p>}

      {phase === "idle" && orphans.length > 0 && (
        <section className="panel">
          <h2>Recovered from a previous run</h2>
          <p className="msg warn">
            {orphans.length} recording{orphans.length > 1 ? "s" : ""} still on this device from a session that
            didn't finish (probably the tab was closed or crashed mid-recording).
          </p>
          {orphans.map((o) => (
            <div key={o.id} className="actions" style={{ marginBottom: 8 }}>
              <button className="ghost" disabled={recoveryBusy} onClick={() => recoverOrphan(o)}>
                Save video ({o.chunkCount} chunks, {o.backend})
              </button>
              <button className="ghost" disabled={recoveryBusy} onClick={() => discardOrphan(o)}>
                Discard
              </button>
            </div>
          ))}
        </section>
      )}

      {phase === "idle" && (
        <section className="panel">
          <h2>Session setup</h2>
          <div className="grid">
            <label>
              Camera
              <select value={settings.facing} onChange={(e) => update("facing", e.target.value as Facing)}>
                <option value="environment">Back camera</option>
                <option value="user">Front camera</option>
              </select>
            </label>
            <label>
              Model
              <select value={settings.variant} onChange={(e) => update("variant", e.target.value as ModelVariant)}>
                <option value="lite">Lite (faster)</option>
                <option value="full">Full (more accurate)</option>
              </select>
            </label>
            <label>
              Runtime
              <select value={settings.delegate} onChange={(e) => update("delegate", e.target.value as DelegatePref)}>
                <option value="auto">GPU, fall back to CPU</option>
                <option value="cpu">CPU only</option>
              </select>
            </label>
            <label>
              Frame size sent to model
              <select value={settings.maxSide} onChange={(e) => update("maxSide", Number(e.target.value))}>
                <option value={480}>480 px</option>
                <option value={640}>640 px</option>
                <option value={960}>960 px</option>
                <option value={0}>Full resolution</option>
              </select>
            </label>
          </div>
          <label className="check">
            <input type="checkbox" checked={settings.rotate180} onChange={(e) => update("rotate180", e.target.checked)} />
            Rotate frames 180° for the model (helps when upside down)
          </label>
          <label className="check">
            <input type="checkbox" checked={settings.showPreview} onChange={(e) => update("showPreview", e.target.checked)} />
            Show the camera picture while recording
          </label>
          <label className="check">
            <input type="checkbox" checked={settings.bypassLevel} onChange={(e) => update("bypassLevel", e.target.checked)} />
            Skip the level check (desktop testing)
          </label>
          <label className="check">
            <input type="checkbox" checked={settings.recordVideo} onChange={(e) => update("recordVideo", e.target.checked)} />
            Record video in chunks (spike B; turn off to fall back to landmarks only)
          </label>
          <button className="primary" disabled={!ready} onClick={startSession}>
            Start session
          </button>
        </section>
      )}

      {/* The stage stays mounted so the video element exists when the camera starts. */}
      <section className={`stage-wrap ${stageVisible ? "" : "is-hidden"}`}>
        <div className="stage" style={{ aspectRatio: ratio }}>
          <div className={`stage-media ${settings.facing === "user" ? "mirror" : ""}`}>
            <video ref={camera.videoRef} playsInline muted autoPlay className={previewVisible ? "" : "preview-off"} />
            <canvas ref={canvasRef} />
          </div>
          {phase === "leveling" && !settings.bypassLevel && level.permission === "granted" && (
            <LevelIndicator tilt={level.tilt} isLevel={level.isLevel} maxPitchDeg={level.maxPitchDeg} hasData={level.hasData} />
          )}
          {phase === "recording" && <div className="rec-badge">Recording {formatTime(elapsed)}</div>}
          {camera.status === "starting" && <div className="stage-note">Starting camera…</div>}
        </div>

        {camera.error && <p className="msg bad">{camera.error}</p>}
        {phase === "leveling" && !settings.bypassLevel && level.permission === "denied" && (
          <p className="msg bad">
            Motion access was denied. Fully close the app, reopen it, tap Start session, and choose Allow.
          </p>
        )}
        {phase === "leveling" && !settings.bypassLevel && level.permission === "unsupported" && (
          <p className="msg warn">This device has no motion sensor. Use “Skip the level check” for desktop testing.</p>
        )}

        <p className="stats">
          {stats.fps.toFixed(0)} fps · {stats.avgMs.toFixed(0)} ms per frame · pose found in {(stats.poseRate * 100).toFixed(0)}% of frames
        </p>
        {phase === "recording" && settings.recordVideo && (
          <p className="stats">
            {recorder.stats.backend} · {recorder.stats.chunkCount} chunks ·{" "}
            {(recorder.stats.totalBytes / 1e6).toFixed(1)} MB written
            {recorder.stats.lastWriteMs != null && ` · last write ${recorder.stats.lastWriteMs} ms`}
          </p>
        )}
        {recorder.error && <p className="msg bad">{recorder.error}</p>}

        <div className="chips">
          <button className={`chip ${settings.rotate180 ? "on" : ""}`} onClick={() => update("rotate180", !settings.rotate180)}>
            Rotate 180° for model: {settings.rotate180 ? "on" : "off"}
          </button>
          <button className={`chip ${settings.showPreview ? "on" : ""}`} onClick={() => update("showPreview", !settings.showPreview)}>
            Camera picture: {settings.showPreview ? "shown" : "hidden"}
          </button>
        </div>

        <div className="actions">
          {phase === "leveling" && (
            <>
              <button className="primary" disabled={!canRecord} onClick={startRecording}>
                {canRecord ? "Start recording" : "Level the phone to record"}
              </button>
              <button className="ghost" onClick={cancelSession}>Cancel</button>
            </>
          )}
          {phase === "recording" && (
            <button className="danger" onClick={stopRecording}>Stop and review</button>
          )}
        </div>
      </section>

      {phase === "review" && result && (
        <section className="panel">
          <h2>Session recorded</h2>
          {videoUrl && (
            <video className="review-video" src={videoUrl} controls playsInline muted />
          )}
          <dl className="summary">
            <div><dt>Duration</dt><dd>{formatTime(result.summary.durationMs)}</dd></div>
            <div><dt>Frames analyzed</dt><dd>{result.summary.frames}</dd></div>
            <div>
              <dt>Pose found</dt>
              <dd>
                {result.summary.frames
                  ? `${Math.round((result.summary.poseFrames / result.summary.frames) * 100)}%`
                  : "–"}
              </dd>
            </div>
            <div><dt>Avg inference</dt><dd>{result.summary.avgInferenceMs} ms</dd></div>
            <div>
              <dt>Camera tilt at start</dt>
              <dd>
                {result.tiltAtStart
                  ? `roll ${result.tiltAtStart.roll}°, pitch ${result.tiltAtStart.pitch}°`
                  : "not measured"}
              </dd>
            </div>
            <div><dt>Events logged</dt><dd>{result.events.length}</dd></div>
            {result.video.recording && (
              <>
                <div><dt>Video size</dt><dd>{(result.video.recording.totalBytes / 1e6).toFixed(1)} MB</dd></div>
                <div>
                  <dt>Storage</dt>
                  <dd>{result.video.recording.chunkCount} chunks · {result.video.recording.backend}</dd>
                </div>
              </>
            )}
          </dl>
          <div className="actions">
            <button className="primary" onClick={save}>Save landmark file</button>
            {videoInfo && <button className="primary" onClick={saveVideo}>Save video</button>}
          </div>
          <div className="actions">
            <button className="ghost" onClick={() => { setResult(null); setVideoInfo(null); setPhase("idle"); }}>
              New session
            </button>
          </div>
        </section>
      )}
    </main>
  );
}

function round2(v: number) {
  return Math.round(v * 100) / 100;
}
