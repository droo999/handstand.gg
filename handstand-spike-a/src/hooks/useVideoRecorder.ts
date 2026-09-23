import { useCallback, useRef, useState } from "react";
import {
  appendChunk,
  createSessionStore,
  finalizeSession,
  discardSession,
  type SessionStore,
  type StorageBackend,
} from "../lib/videoStore";

export type RecorderStats = {
  chunkCount: number;
  totalBytes: number;
  mimeType: string;
  backend: StorageBackend;
  lastChunkAt: number | null;
  lastWriteMs: number | null;
};

export type FinalizedRecording = {
  blob: Blob;
  chunkCount: number;
  totalBytes: number;
  mimeType: string;
  backend: StorageBackend;
};

const EMPTY_STATS: RecorderStats = {
  chunkCount: 0,
  totalBytes: 0,
  mimeType: "",
  backend: "memory",
  lastChunkAt: null,
  lastWriteMs: null,
};

/** In preference order: H.264 in an mp4 container plays natively in Safari; the rest are Chrome/Android. */
const MIME_CANDIDATES = [
  "video/mp4;codecs=avc1.42E01E",
  "video/mp4",
  "video/webm;codecs=vp9",
  "video/webm;codecs=vp8",
  "video/webm",
];

function pickMimeType(): string | undefined {
  if (typeof MediaRecorder === "undefined") return undefined;
  return MIME_CANDIDATES.find((c) => MediaRecorder.isTypeSupported(c));
}

/**
 * Wraps `MediaRecorder` so each chunk (from `timeslice`) is written straight to durable
 * storage (see `lib/videoStore.ts`) and dropped from JS memory, instead of accumulating an
 * array of Blobs for the whole session. That's the thing spike B needs to prove works for
 * 20-30 minutes on an iPhone without running out of memory.
 */
export function useVideoRecorder() {
  const recorderRef = useRef<MediaRecorder | null>(null);
  const storeRef = useRef<SessionStore | null>(null);
  const nextIndexRef = useRef(0);
  const [stats, setStats] = useState<RecorderStats>(EMPTY_STATS);
  const statsRef = useRef(EMPTY_STATS);
  const [error, setError] = useState<string | null>(null);

  const setStatsBoth = (next: RecorderStats) => {
    statsRef.current = next;
    setStats(next);
  };

  const start = useCallback(async (stream: MediaStream, sessionId: string, timesliceMs = 2000) => {
    const mimeType = pickMimeType();
    if (!mimeType) throw new Error("This browser's MediaRecorder can't produce mp4 or webm");

    const store = await createSessionStore(sessionId, mimeType);
    storeRef.current = store;
    nextIndexRef.current = 0;
    setError(null);
    setStatsBoth({ ...EMPTY_STATS, mimeType, backend: store.backend });

    const recorder = new MediaRecorder(stream, { mimeType });
    recorderRef.current = recorder;

    recorder.ondataavailable = (e: BlobEvent) => {
      if (!e.data || e.data.size === 0) return;
      const index = nextIndexRef.current++;
      const t0 = performance.now();
      void appendChunk(store, index, e.data)
        .then(() => {
          const prev = statsRef.current;
          setStatsBoth({
            ...prev,
            chunkCount: prev.chunkCount + 1,
            totalBytes: prev.totalBytes + e.data.size,
            lastChunkAt: Date.now(),
            lastWriteMs: Math.round(performance.now() - t0),
          });
        })
        .catch((err: unknown) => setError(`Chunk write failed: ${(err as Error)?.message ?? err}`));
    };
    recorder.onerror = (e) => {
      const message = (e as unknown as { error?: DOMException }).error?.message ?? "unknown error";
      setError(`Recorder error: ${message}`);
    };

    recorder.start(timesliceMs);
  }, []);

  /** Stops the recorder, waits for the last chunk to land, then assembles the full video. */
  const stop = useCallback(async (): Promise<FinalizedRecording | null> => {
    const recorder = recorderRef.current;
    const store = storeRef.current;
    if (!recorder || !store) return null;

    await new Promise<void>((resolve) => {
      if (recorder.state === "inactive") {
        resolve();
        return;
      }
      recorder.addEventListener("stop", () => resolve(), { once: true });
      recorder.stop();
    });
    recorderRef.current = null;
    storeRef.current = null;

    const finalized = await finalizeSession(store);
    return { ...finalized, mimeType: store.mimeType, backend: store.backend };
  }, []);

  /** Stops without keeping anything (session cancelled). */
  const discard = useCallback(async () => {
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") recorder.stop();
    recorderRef.current = null;
    const store = storeRef.current;
    storeRef.current = null;
    if (store) await discardSession(store);
    setStatsBoth(EMPTY_STATS);
  }, []);

  return { start, stop, discard, stats, statsRef, error };
}
