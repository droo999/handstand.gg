import { useCallback, useEffect, useRef, useState } from "react";

export type Facing = "user" | "environment";
export type CameraStatus = "idle" | "starting" | "live" | "error";

export function useCamera() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [status, setStatus] = useState<CameraStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  const stop = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setStatus("idle");
  }, []);

  const start = useCallback(
    async (facing: Facing) => {
      stop();
      setStatus("starting");
      setError(null);
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            facingMode: { ideal: facing },
            width: { ideal: 1280 },
            height: { ideal: 720 },
            frameRate: { ideal: 30 },
          },
        });
        streamRef.current = stream;
        const video = videoRef.current;
        if (!video) throw new Error("Video element is not mounted");
        video.srcObject = stream;
        await video.play();
        setSize({ width: video.videoWidth, height: video.videoHeight });
        setStatus("live");
      } catch (err) {
        setError(describeCameraError(err));
        setStatus("error");
      }
    },
    [stop],
  );

  useEffect(() => stop, [stop]);

  return { videoRef, status, error, size, start, stop };
}

function describeCameraError(err: unknown): string {
  const name = (err as DOMException)?.name;
  if (name === "NotAllowedError") {
    return "Camera access was blocked. Allow the camera for this site in Settings, then try again.";
  }
  if (name === "NotFoundError") return "No camera was found on this device.";
  if (name === "NotReadableError") return "The camera is in use by another app.";
  if (!window.isSecureContext) return "The camera needs HTTPS. Open the deployed https:// link.";
  return `Could not start the camera: ${(err as Error)?.message ?? String(err)}`;
}
