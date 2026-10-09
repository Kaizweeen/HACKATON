# Demo runbook

The story in one minute: **phone A sees a pothole with its own camera (the AI runs on the phone), the laptop hub tells everyone,
and phone B, coming down the same street, is warned "Pothole ahead" before it gets there. The internet is off the whole time.**

## Before the day

```bash
npm install
npm run build
npm run rehearse          # two emulated phones, the real hub, the real model: writes .rehearsal/report.md (see below)
```

`npm run rehearse` must end with every check passing. It needs Playwright's Chromium once (`npx playwright install chromium`).
For the camera it uses `model/work/camera/road.y4m` if you made one (`python model/tools/make_camera_video.py`, after
`python model/tools/build_public_dataset.py`), else Chromium's test pattern plus Demo Mode on phone B.

Then rehearse on the real phones and hotspot with the README's **Offline demo checklist** (certificate, install, airplane mode).
Things a laptop cannot rehearse for you: the camera mount, GPS under the sky, sunlight on the screen, and the hotspot.

## A. The real thing: live detection + warning (two phones)

1. Laptop: hotspot on, internet off. `npm run hub -- --fresh --pin <event-pin>`. The hub prints `https://<ip>:8443/?pin=...`.
2. Each phone: join the hotspot, open that address once (the app remembers the PIN and drops it from the address bar).
   Debug must say **Offline ready: yes, cached**, and the Drive screen **Detector: ONNX webgpu** or **ONNX wasm** (never MOCK).
3. Phone A: **Start**, point the camera at the road, or at road photos on a laptop screen or prints if you are indoors.
   A box appears on a pothole; after 3 frames in a row it is **confirmed** (short vibration) and appears on both phones' maps.
4. Phone B (outdoors: drive or walk the same street behind A; indoors: stand where A stood, Start): it shows
   **"Pothole ahead · 40 m · seen by 1 phone"**, beeps twice and vibrates.
5. Show resilience: stop the hub. Phones keep detecting, the banner says the hub is gone, new hazards wait to sync.
   Start the hub again: they reconnect and catch up. Airplane mode + reopen from the Home Screen: the app, the map and the
   hazards are all still there.

What to say about accuracy: only what is in [`model/RESULTS.md`](model/RESULTS.md). The model is a baseline trained on public
photos (not Philippine roads, and **no flooded roads at all**); a confirmation needs 3 consecutive frames, which filters most
single-frame mistakes. Flooded road appears in the legend and in Demo Mode, but the live model never reports one.

## B. Fallback: Demo Mode (no camera, no GPS, no model needed)

If the camera, GPS or venue misbehaves: Drive tab → **Demo mode** → **Start** (or open the app with `?demo=1`). A scripted
60-second drive down M. L. Quezon Street in Antipolo goes through the **real** confirmer, store, sync, map and warnings.
Eight hazards confirm, two are rejected (a too-short blip and a stretch below threshold). On the second lap the phone
warns about the first lap's finds; two phones running it confirm the same places, so the map shows **x2**.
Everything is labelled DEMO: say out loud that it is a scripted drive, not a measurement.

`npm run fake-device` in a second terminal adds hazards from other "riders" while you talk.

Last resort: [`docs/demo-mode-fallback.webm`](docs/demo-mode-fallback.webm) is a 78-second screen recording of Demo Mode
(headless Chromium, not a real phone): the drive, the hazards on the real Antipolo map, and the second lap's "Road crack ahead"
warning.

## What the rehearsal report checks

Trusted HTTPS and offline caching on both phones · a phone without the event PIN is refused · the detector is the real ONNX
model · the camera produces confirmations · the hub is stopped mid-drive and restarted, and hazards found meanwhile reach it ·
both phones and the hub end with the same hazards and nothing waiting to sync · the phone driving 15 s behind is warned about
hazards ahead · airplane-mode reload works with the map tiles from the phone · no page errors.
