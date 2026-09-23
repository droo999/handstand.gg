# Handstand spike A + B

Two throwaway spikes in one app, since B builds directly on A's camera/level/pose pipeline.

**Spike A:** does pose tracking hold up upside down, at a usable frame rate, with the level
gate and export working?

**Spike B:** can a 20-30 minute session survive as chunked video recording in the browser —
checking memory, screen sleep, backgrounding, and how well landmarks line up with the
video? This is the go/no-go for the PWA approach.

What it does: camera → level gate (recording is disabled until the phone is level) →
live MediaPipe stick figure (trapezoid torso, line limbs) → records a per-frame landmark log
**and** the session video, chunked straight to OPFS/IndexedDB as it's captured → exports the
landmarks as JSON and offers the recorded video for saving. If the tab is killed mid-session,
the chunks already on disk are picked up on the next launch (see "Crash recovery" below).

What it deliberately does not do: detect handstands, compute angles, or talk to a backend.

## Run it

```bash
npm install          # also copies the MediaPipe wasm and downloads the pose models (~15 MB)
npm run dev          # http://localhost:5173, works with a laptop webcam
```

For the level check, use "Skip the level check" on desktop (laptops have no motion sensor).

### On the iPhone

Camera and motion sensors need HTTPS, and `localhost` only counts as secure on the same
machine, so the easiest route is to deploy:

1. Push this folder to a GitHub repo.
2. Import it in Vercel (or Netlify). Build command `npm run build`, output `dist`.
   The `postinstall` script downloads the models during the build.
3. Open the deployed URL in Safari on the iPhone. Then repeat step 4 below using
   Share → Add to Home Screen, and test the installed app too.

Alternative: `npm run dev:https` serves a self-signed certificate on your Wi-Fi. Safari will
warn; camera access may or may not work with it.

## What to test, in order

### Spike A (short sessions)

1. **Level gate.** Tap Start session, allow motion access. Tilt the phone clockwise: the
   horizon line should rotate counter-clockwise on screen (staying level with the world).
   If it moves the wrong way, negate `roll` in `LevelIndicator.tsx`. It should go green
   after about 0.6 s within ±1.5° roll (pitch/incline up to ±26° is allowed).
2. **Frame rate.** Watch the fps and ms line under the preview. Try lite vs full, and
   480/640/960 px. Note the numbers for the iPhone 14.
3. **Upside down, rotation off.** Prop the phone side-on, start recording, do handstands
   (or hold the phone and film someone / a video). Left is cyan, right is orange. Look for
   swapped colors, jumping joints, or the skeleton vanishing.
4. **Upside down, rotation on.** Turn on "Rotate 180° for model" and repeat. Compare the
   "pose found" percentage and how stable the skeleton looks.
5. **Export.** Stop, then Save landmark file. On iPhone this opens the share sheet
   (Save to Files / AirDrop). Keep these files: they are the test data for the
   segmentation engine.

### Spike B (long sessions)

6. **20-30 minute recording.** Leave "Record video in chunks" on and record a long
   session (kick up repeatedly, or just let the camera run). Watch the live
   `chunks · MB written` line under the preview — bytes should climb steadily rather than
   jumping all at once at the end, confirming chunks are actually landing on disk as you go
   rather than piling up in memory.
7. **Storage backend.** After stopping, the review screen shows which backend was used
   (`opfs`, `indexeddb`, or `memory` as a last resort) and the total chunk count/size.
   `memory` means neither OPFS nor IndexedDB was available — that defeats the point of
   spike B, so treat it as a fail for whatever browser reported it.
8. **Backgrounding.** During a long recording, switch apps for a while and come back.
   The summary's "Events logged" count includes visibility changes, and (if the camera
   was actually killed by iOS) a `camera-track-ended` event; a `recorder-stalled` event
   means chunks stopped landing for 6+ seconds without the track formally ending.
9. **Crash recovery.** Mid-recording, force-quit the app (or close the tab) instead of
   tapping Stop. Reopen it: the idle screen should show "Recovered from a previous run"
   with the chunk count from before the crash. Save or discard it. This is the actual
   proof that chunked storage protects a long session from a browser/OS kill.
10. **Playback sync.** Save both the video and the landmark JSON from the same session,
    and scrub the video against the `frames[].t` timestamps to see how well they line up.

## Layout

```
src/lib/pose.ts            MediaPipe setup, 180° frame rotation, landmark indices
src/lib/skeleton.ts        stick-figure drawing
src/lib/export.ts          log format + share/download (landmarks JSON, video blob)
src/lib/videoStore.ts      spike B: chunked video storage (OPFS/IndexedDB/memory), crash recovery
src/hooks/useCamera.ts     getUserMedia lifecycle, exposes the raw MediaStream
src/hooks/useLevel.ts      gravity → roll/pitch, permission, level gate
src/hooks/useVideoRecorder.ts  MediaRecorder → videoStore chunk pipeline
src/components/LevelIndicator.tsx
src/App.tsx                session flow + detection loop + spike B wiring
scripts/setup-assets.mjs   copies wasm, downloads models into public/
```

## Notes

- Landmarks are logged in the original camera frame (not mirrored, not rotated), so the
  same file works for playback overlays later.
- Frame timestamps are `performance.now()` relative to the recording start, same clock the
  video chunks are recorded on, so they should line up (step 10 above is the actual check).
- The 33 landmarks are exported for experimenting. The app can later keep only the ~19
  body landmarks it needs.
- MediaRecorder mimeType preference is mp4/H.264 first (plays natively in Safari), falling
  back to webm. Whichever was actually used is in the export's `video.recording.mimeType`.
- The chunked-storage backend is auto-detected once per page load: OPFS if writable,
  otherwise IndexedDB, otherwise an in-memory array as a last resort (no crash protection).
