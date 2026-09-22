# Handstand spike A

A throwaway spike to answer one question on a real iPhone: **does pose tracking hold up
upside down, at a usable frame rate, with the level gate and export working?**

What it does: camera → level gate (recording is disabled until the phone is level) →
live MediaPipe stick figure (trapezoid torso, line limbs) → records a per-frame landmark log
→ exports it as JSON.

What it deliberately does not do: record video (that is spike B), detect handstands,
compute angles, or talk to a backend.

> This was written without being able to run it (no network in the authoring environment).
> Only the TypeScript logic was checked against stub types. Expect to fix a small thing or two.

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

1. **Level gate.** Tap Start session, allow motion access. Tilt the phone clockwise: the
   horizon line should rotate counter-clockwise on screen (staying level with the world).
   If it moves the wrong way, negate `roll` in `LevelIndicator.tsx`. Then aim the camera
   upward: the readout must say "Camera up" (and the dot moves up). If it says "down", flip
   `GRAVITY_READS_INVERTED` in `useLevel.ts`. The gate goes green after about 0.6 s within
   the limits in `DEFAULT_LIMITS` (roll ±2°, camera up to 6° above and 3° below the
   horizon), and Start recording enables. Adjust the limits there.
2. **Frame rate.** Watch the fps and ms line under the preview. Try lite vs full, and
   480/640/960 px. Note the numbers for the iPhone 14.
3. **Upside down, rotation off.** Prop the phone side-on, start recording, do handstands
   (or hold the phone and film someone / a video). Left is cyan, right is orange. Look for
   swapped colors, jumping joints, or the skeleton vanishing.
4. **Upside down, rotation on.** Turn on "Rotate 180° for model" and repeat. Compare the
   "pose found" percentage and how stable the skeleton looks.
5. **Backgrounding.** During a recording, switch apps for a few seconds and come back. The
   summary shows how many app switches were logged; check whether the camera and skeleton
   resumed.
6. **Export.** Stop, then Save landmark file. On iPhone this opens the share sheet
   (Save to Files / AirDrop). Keep these files: they are the test data for the
   segmentation engine.

## Layout

```
src/lib/pose.ts          MediaPipe setup, 180° frame rotation, landmark indices
src/lib/skeleton.ts      stick-figure drawing
src/lib/export.ts        log format + share/download
src/hooks/useCamera.ts   getUserMedia lifecycle
src/hooks/useLevel.ts    gravity → roll/pitch, permission, level gate
src/components/LevelIndicator.tsx
src/App.tsx              session flow + detection loop
scripts/setup-assets.mjs copies wasm, downloads models into public/
```

## Notes

- Landmarks are logged in the original camera frame (not mirrored, not rotated), so the
  same file works for playback overlays later.
- Frame timestamps are `performance.now()` relative to the recording start. Spike B will
  measure how these line up with the recorded video.
- The 33 landmarks are exported for experimenting. The app can later keep only the ~19
  body landmarks it needs.
