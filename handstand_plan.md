# Handstand alignment tracker: project plan

A computer-vision project for my portfolio. It tracks handstand alignment from side-view video and is meant for reflecting on form and tracking consistency and progression, not for real-time coaching.

**Constraints:** no cost, not published to any app store. Built as a PWA and tested on an iPhone 14.

---

## Features

### Sessions and recording
- Users record **sessions** (many handstands in one recording), filmed from the side.
- **Level gate:** before recording, the camera view shows a horizontal line indicator that changes as the phone tilts and turns green when the phone is straight. Recording can't start until it's level. Only left/right tilt (roll) is gated; inclining or declining the phone (pitch) is allowed.
- **No overlay on the camera view.** Once recording starts, a live skeletal outline of the body (trapezoid torso, line limbs) mirrors the user's movements.
- No audio feedback.

### Handstand detection
- A **stopwatch** starts when the user is actually in a handstand and stops when they leave it. A handstand starts when the user leaves the piked position and has their feet floating, somewhat close to the center of mass.
- The stopwatch can **resume within the same session** (people often kick up again right after falling), and the overlay shows the **number of handstands so far** in the session.
- Each handstand is its own **time-series clip**, trimmed from the moment the hands are placed on the ground until **5 seconds after the handstand ends**.

### Playback overlays
- Overlays appear **only during playback**, one at a time (they can't be stacked):
  - **Line:** joint positions plus a vertical line, to see how stacked and straight the handstand is
  - **Center of mass**
  - **Shoulder angle**
  - **Stopwatch** (with the handstand count)

### History
- Past sessions are dated and time-stamped, which supports one or two sessions a day (e.g. morning and night).
- Navigate by session, then look at each handstand within it, rather than one long list of recordings.

### Analytics
- Metrics extracted from the recordings and stored in a database: total time in handstand, total time in good form, progress over the past month, and consistency across sessions.

### Social
- A Strava-like community side: post handstands, react to others' posts, add friends.

---

## Tech stack

| Area | Choice |
|---|---|
| App | PWA: React + TypeScript + Vite, installed to the iPhone home screen from Safari |
| Hosting | Free tier on Vercel or Netlify (HTTPS is required for camera and motion sensors) |
| Pose estimation | MediaPipe Pose Landmarker, on-device, self-hosted. Test rotating frames 180° so inverted poses look upright to the model |
| Camera and recording | `getUserMedia` plus `MediaRecorder` on the raw camera stream. Video is saved in chunks to browser storage (OPFS/IndexedDB) to handle long sessions. Wake Lock keeps the screen on |
| Level gate | `devicemotion` gravity vector, smoothed; gates on roll only (pitch is logged), with an iOS permission tap |
| Detection and metrics | Pure TypeScript functions that run on the saved landmark time series after the session: a state machine with hysteresis, backtracking to find hand placement, angles, and center of mass from segment mass fractions |
| Playback overlays | Drawn at playback time from the stored landmarks |
| Backend | Supabase free tier (Postgres, Auth, Storage, row-level security) |
| What gets stored | Only the trimmed handstand clips (compressed), their landmark data, and the derived metrics. The full session video is not stored in the database |

---

## Roadmap

1. **Spike A (on the iPhone):** camera, level gate, live stick figure, 180° rotation toggle, fps counter, landmark export. Checks that pose tracking holds up upside down.
2. **Spike B:** a 20-30 minute session recorded in chunks. Checks memory, screen sleep, backgrounding, and how well landmarks line up with the video. This is the go/no-go for the PWA approach.
3. **Spike C:** cutting a standalone playable clip out of a session recording (WebCodecs or ffmpeg.wasm re-encode of a short range).
4. **Session recorder:** session start, level gate, record, and save video and landmarks locally.
5. **Handstand detection engine:** landmarks in, handstands and metrics out, tested against sessions I label by hand.
6. **Playback:** history by session, per-handstand clip player, and the four overlay modes.
7. **Supabase sync and analytics dashboard.**
8. **Social features.**
9. **Portfolio polish:** demo video, architecture diagram, and an evaluation section (e.g. stopwatch error against hand labels).

**Fallback if long recording fails in the browser:** record with the iPhone's normal Camera app and import the video into the PWA for analysis.

---

## Open decisions

- Should the live stick figure sit on top of the camera picture or replace it? (Spike A has a toggle to compare.)
- Should each overlay be drawn on the fly at playback, or exported as its own rendered video file?
- If someone kicks up again within 5 seconds of falling, the two clips overlap. Proposal: cut the first clip at the next hand placement.
- The thresholds for "good form" for each metric.
