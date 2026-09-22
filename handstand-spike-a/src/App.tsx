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
  type FrameRecord,
  type LogEvent,
  type SpikeExport,
  type TiltSample,
} from "./lib/export";
import { useCamera, type Facing } from "./hooks/useCamera";
import { useLevel } from "./hooks/useLevel";
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
};

const DEFAULTS: Settings = {
  facing: "environment",
  variant: "lite",
  delegate: "auto",
  maxSide: 640,
  rotate180: false,
  showPreview: true,
  bypassLevel: false,
};

type RecordingLog = {
  startPerf: number;
  frames: FrameRecord[];
  tiltSamples: TiltSample[];
  events: LogEvent[];
  tiltAtStart: { roll: number; pitch: number } | null;
  infMsSum: number;
  infCount: number;
  poseFrames: number;
};

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

  const camera = useCamera();
  const level = useLevel(phase === "leveling");
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // The detection loop reads these instead of React state, so it never re-subscribes.
  const settingsRef = useRef(settings);
  const phaseRef = useRef(phase);
  const logRef = useRef<RecordingLog | null>(null);
  const wakeRef = useRef<WakeLockSentinel | null>(null);
  useEffect(() => { settingsRef.current = settings; }, [settings]);
  useEffect(() => { phaseRef.current = phase; }, [phase]);

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

  // ---- Actions -------------------------------------------------------------------------
  const startSession = async () => {
    setNotice(null);
    // Must be first: iOS only shows the motion permission prompt inside a tap handler.
    if (!settings.bypassLevel) await level.request();
    setPhase("leveling");
    await camera.start(settings.facing);
    await acquireWake();
  };

  const startRecording = () => {
    logRef.current = {
      startPerf: performance.now(),
      frames: [],
      tiltSamples: [],
      events: [],
      tiltAtStart: level.hasData ? { roll: round2(level.latest.current.roll), pitch: round2(level.latest.current.pitch) } : null,
      infMsSum: 0,
      infCount: 0,
      poseFrames: 0,
    };
    setElapsed(0);
    setPhase("recording");
  };

  const stopRecording = () => {
    const log = logRef.current;
    if (!log) return;
    const durationMs = Math.round(performance.now() - log.startPerf);
    setResult({
      schema: "handstand-spike-a/v1",
      createdAt: new Date().toISOString(),
      userAgent: navigator.userAgent,
      layout: LAYOUT,
      video: { width: camera.size.width, height: camera.size.height, facing: settings.facing },
      settings: { ...settings, model: model.status === "ready" ? model.delegate : null },
      tiltAtStart: log.tiltAtStart,
      tiltSamples: log.tiltSamples,
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
            <LevelIndicator tilt={level.tilt} isLevel={level.isLevel} toleranceDeg={level.toleranceDeg} hasData={level.hasData} />
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
            <div><dt>App switches</dt><dd>{result.events.length}</dd></div>
          </dl>
          <div className="actions">
            <button className="primary" onClick={save}>Save landmark file</button>
            <button className="ghost" onClick={() => { setResult(null); setPhase("idle"); }}>New session</button>
          </div>
        </section>
      )}
    </main>
  );
}

function round2(v: number) {
  return Math.round(v * 100) / 100;
}
