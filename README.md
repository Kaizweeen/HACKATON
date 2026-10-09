# Lubak Alert

*Lubak* is Filipino for pothole. A phone on a motorbike or jeep looks at the road with an **AI model that runs on the phone itself**, confirms what it saw
with the accelerometer and GPS, and warns other riders through a **laptop hub on a Wi-Fi hotspot**, with the internet switched off.
It is an offline-first PWA: no cloud, no camera frame ever leaves the phone, no server you do not own.

AppBuildersPH Hackathon 2026 · theme: **Local AI**

```text
phone (installed PWA, works with the internet cut)                              laptop (same hotspot)
camera ─▶ detector ─▶ confirmer ─▶ store (IndexedDB) ◀─▶ sync ◀═ wss://<ip>:8443/ws ═▶ hub
 5-10 fps  YOLOv8n     3 frames,    merge on write                                       merge · broadcast to the others
           ONNX, on    + GPS,           │                                                snapshot to disk every 10 s
           the phone   + jolt boost     ▼                                                serves the built PWA over HTTPS
sensors: jolts, GPS ─▶ (confirmer)   map (Leaflet, tiles from the app's own folder)
```

The full flowchart and architecture, every box and arrow mapped to the code that implements it and the test that checks it: **[`docs/flowchart.md`](docs/flowchart.md)**.

## Status: what works today, and what is still open

**Works, and is checked** by 330+ automated tests and by `npm run rehearse` (two emulated phones in Chromium against the real hub and the real model, see [`DEMO.md`](DEMO.md)):

* **Detection on the phone.** `app/public/models/lubak.onnx` is a YOLOv8n trained on public pothole and crack photos; how it was trained and what it measured on held-out photos is in [`model/RESULTS.md`](model/RESULTS.md) (on 179 held-out public photos: mAP50 0.69; a pothole is found in 62 of 67 photos that show one, at a per-box precision of 0.81; cracks are weaker).
  onnxruntime-web runs it on WebGPU, or WASM where WebGPU is missing; a parity test proves the app decodes the model's raw output exactly as Ultralytics does.
* **Confirmation.** 3 consecutive frames above a per-class threshold chosen on validation data, a usable GPS fix, and a confidence boost when the accelerometer feels the bump.
* **Sharing without internet.** IndexedDB store with an offline queue; the laptop hub (HTTPS + WebSocket) merges and relays hazards, keeps a snapshot, expires old ones; an optional event PIN keeps strangers on the hotspot out.
* **Warning other riders.** A phone approaching a hazard that any phone reported gets **"Pothole ahead · 40 m · seen by 2 phones"**, two beeps and a vibration, about 6 s before it.
* **Offline map.** Real OpenStreetMap tiles of Antipolo (via Overture Maps) are part of the app and cached on the phone; the demo loop follows real streets.
* **Offline-first PWA.** The service worker caches the app, the model, the onnxruntime runtime and the tiles: after one visit it works in airplane mode.
* **Demo Mode, fake devices, CI.** A scripted drive through the real pipeline for the stage, `npm run fake-device` for load, and GitHub Actions running tests, build and the rehearsal on every push.

**Still open** (these need people, phones and roads, not more code):

* **Flooded roads are not detected.** No labelled flood images were available, so the model has the class but never reports it (0 detections in validation and test). The class stays in the contract, the map and Demo Mode.
* The model has **never seen a Philippine road or the phone mount**: its numbers are on public photos. A few hundred labelled frames from the real mount will matter more than anything else ([`model/README.md`](model/README.md)).
* **Not yet tried on a physical phone**, real GPS, motion sensors, a hotspot, a phone GPU's WebGPU, or iOS. The rehearsal emulates Android phones in Chromium; it does not replace a ride.
* The jolt threshold (4 m/s²) and boost (+0.15) are untested placeholders: there was no accelerometer data.
* A hazard cannot be marked as repaired; it expires (floods 6 h, potholes and cracks 21 days).

## Repository layout

```text
shared/   TypeScript contract: types, merge, expiry, geohash, WebSocket messages. Imported by hub and app. Start here: shared/README.md
hub/      Node + TypeScript server (express, ws, HTTPS), tools/fake-device
app/      Vite + plain TypeScript PWA: camera, detector, confirmer, sensors, store, sync, map, screens, demo
model/    YOLOv8n training notebook, dataset conversion, ONNX export + verification, evaluation. Start here: model/README.md
test/     the flowchart as a test: the real app code talking to the real hub, in one process
docs/     flowchart.md: the flowchart and the architecture as diagrams, mapped to code and tests
scripts/  dev.mjs (hub + app dev server together), demo.mjs (npm run demo), rehearse.ts (npm run rehearse: the two-phone rehearsal)
```

## Quick start on one computer (no phone needed)

Needs **Node 22.12 or newer**. Python is only needed for `model/`.

```bash
npm install
npm test               # shared, hub and app unit + integration tests
npm run typecheck
npm run build          # type-checks, then builds the PWA into app/dist
npm run hub            # HTTPS + WebSocket hub: makes a certificate on first run, prints the LAN URL
npm run fake-device    # in a second terminal: fake phones driving the demo loop on real streets in Antipolo
```

**Shortcut: `npm run demo`** builds the app and starts the hub with an empty store (add `-- --pin <code>` for an event PIN). **`npm run rehearse`** runs the whole stage demo with two emulated phones and writes `.rehearsal/report.md`. The runbook is [`DEMO.md`](DEMO.md).

Open **https://localhost:8443** and look at the Map tab: hazards appear as the fake device reports them. Your browser will warn about the certificate until you trust the hub's CA
(see below); on this computer you can click through for a quick look, but the service worker (offline mode) only registers once the certificate is trusted.
Drive tab → **Demo mode** replays a scripted 60-second drive through the real confirmer, store, sync and map, without a camera.

For development use `npm run dev` (hub + live-reloading app at https://localhost:5173, service worker off). The hub serves whatever `npm run build` last produced, so rebuild after changing the app.

## Running it with phones

### 1. One network, no internet needed

| Setup | Notes |
| --- | --- |
| **The laptop shares its own hotspot** (Windows Mobile Hotspot, macOS Internet Sharing, Linux NetworkManager hotspot) | Best. The laptop's address on its own hotspot normally stays fixed (Windows usually 192.168.137.1). |
| A phone's hotspot, with the laptop and the other phones joined to it | Works, but the laptop may get a different address whenever it reconnects. |
| A travel router | Give the laptop a DHCP reservation. Check the router does not enable "AP / client isolation". |

The app, the model, the map and the hub all live on the laptop. The internet is never used, and the demo is more convincing with the uplink unplugged.

### 2. Start the hub and read the LAN URL

```bash
npm run build && npm run hub
```

The hub prints every LAN address it found, hotspot gateways first, with hints:

```text
 LUBAK ALERT HUB is running

 Open this on every phone (same Wi-Fi / hotspot as this computer):
   https://192.168.137.1:8443   (Wi-Fi, Windows Mobile Hotspot: this PC is the hotspot)
   https://localhost:8443   (this computer)
```

If several addresses are listed (VPN, Docker, Ethernet), use the one on the hotspot's subnet. To find it yourself: `ipconfig` (Windows), `ipconfig getifaddr en0` (macOS), `hostname -I` (Linux).
If a phone cannot reach it: allow Node through the laptop firewall on *private* networks (TCP 8443 and 8080), turn off VPNs on the laptop, and check the router for client isolation.

> **The address is part of the app's identity.** A phone caches the app per origin (`https://<ip>:8443`). If the laptop's address changes, the phone sees a *new* site with an empty cache: open the new address once while connected and let it cache again.
> The hub reissues its certificate for the new address on the next start; phones keep trusting the same CA.

### 3. Trusting the certificate (once per phone)

Camera, motion sensors and service workers need HTTPS, and browsers will not register a service worker behind an untrusted certificate, so without this step there is no offline mode.
The hub generates its own certificate authority (`hub/.certs/`, never committed) and serves its **public** certificate on a plain-HTTP helper page.

1. On the phone, connected to the same network, open **`http://<laptop-ip>:8080`** (the hub prints this exact line) and tap **Download certificate**.
2. **Android (Chrome).** Settings → Security (or Security & privacy) → More security settings → Encryption & credentials → **Install a certificate** → **CA certificate** → Install anyway → pick the downloaded `lubak-hub-ca.crt`. Android 11 and newer will not install it by tapping the file; it has to go through Settings. Samsung: Biometrics and security → Other security settings → Install from device storage.
3. **iPhone / iPad (Safari, not Chrome).** Allow the profile download → Settings → **Profile Downloaded** → Install → then Settings → General → About → **Certificate Trust Settings** → switch the Lubak Alert Hub Local CA on.
4. Compare the SHA-256 fingerprint on the helper page with the one the hub printed, then open **`https://<laptop-ip>:8443`**. There must be **no warning**. Use **Install app** (Android) or **Share → Add to Home Screen** (iOS).
5. **After the event, remove the certificate from the phone** (Android: Settings → Security → Encryption & credentials → User credentials; iOS: Settings → General → VPN & Device Management). Whoever holds the CA key in `hub/.certs/` on the laptop could otherwise impersonate websites to that phone.

If **mkcert** is installed on the laptop, the hub uses it and the laptop's own browser trusts the result after `mkcert -install`. mkcert's CA is your personal development CA, so for phones prefer `npm run hub -- --no-mkcert`, which uses a CA that exists only for this app.

### 4. Let the phone cache everything, then cut the network

Open **Debug** and wait for **Offline ready: yes, cached**. That means the service worker has stored the app, the ONNX model, the onnxruntime WASM runtime and the map tiles. Then grant camera, precise location and (iPhone) motion access from the Drive tab.
Turn **mobile data off** for the demo: some Android phones route traffic away from a Wi-Fi network that has no internet unless you tell them to stay on it ("Wi-Fi has no internet access, stay connected?" → yes).

### Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| Page does not load on the phone | Different network, client isolation, laptop firewall, VPN on the laptop, or the address changed. |
| Certificate warning after installing the CA | The address is not covered (restart the hub to reissue), the CA was installed under the wrong type ("CA certificate"), or on iOS the full-trust switch is off. |
| Camera or motion permission never appears | Not a trusted HTTPS page (the Drive screen lists what is missing). |
| Debug: *Offline ready* never turns yes | Service worker refused: certificate not trusted. |
| Old app or old model after a rebuild | Debug → **Reset app cache & reload** (the model is precached). |
| Red MOCK badge | The model file is missing or invalid; the Drive screen shows why. |
| Map is blank but markers appear | No tiles for that area or zoom. Markers still work. |
| Two phones do not see each other's hazards | Debug → Sync: state, hub URL, and *Clock vs hub* (a phone whose clock is more than 10 minutes ahead has its hazards rejected). |
| A cleared hub keeps getting its hazards back | Phones re-upload what they hold. Use Debug → **Clear hazards on this phone** on every phone, and `npm run hub -- --fresh`. |

## The detector

| Flag | Meaning |
| --- | --- |
| `auto` (default) | The real model from `/models/lubak.onnx`. If it cannot load, the mock **with a visible red MOCK badge and the reason**. A silent fallback would pass random boxes off as inference. |
| `onnx` | The real model or a readable error. Never falls back. |
| `mock` | Random but temporally coherent boxes, so everything downstream can be built before a model exists. |

Set it with `?detector=`, in Debug → Controls (saved on that phone), or at build time with `VITE_DETECTOR`. Inference runs on WebGPU where available and on WASM otherwise; the Drive and Debug screens show which one, and the timing of each stage.
The WASM runtime runs single-threaded (threads need cross-origin isolation, which the hub does not enable).

**Adding the real model:** train and export with [`model/README.md`](model/README.md), which writes and verifies `app/public/models/lubak.onnx` (input `[1,3,320,320]`, output `[1,7,2100]`, classes `pothole, crack, flooded_road`, in that order), then commit it, `npm run build`, and **Reset app cache** on each phone.

## Demo Mode

If the camera, GPS or model misbehaves on stage, flip **Demo mode** on the Drive tab (or open the app with `?demo=1`). A synthetic camera, scripted detections, scripted jolts and a GPS path along the test route feed the **real** confirmer, store, sync and map.
The script has ten encounters: eight should confirm and two must be rejected (a blip that is too short, a stretch below threshold). Two phones running it confirm the same places, so the map shows "x2". Everything is labelled DEMO. It is a rehearsal aid, not a measurement.

## Configuration reference

**App URL flags:** `?detector=auto|mock|onnx` · `?model=/models/other.onnx` · `?fps=5..10` (default 8) · `?hub=wss://<ip>:8443/ws` · `?demo=1` · `?camera=rear|front` (default rear: the back camera faces the road when the phone is mounted; front is for testing). The query beats the Debug screen's saved settings, which beat build-time `VITE_*` values.
**App build-time:** `VITE_DETECTOR`, `VITE_TILE_ATTRIBUTION` (default "© OpenStreetMap contributors (offline tiles)"; change it if your tiles come from elsewhere).

**Hub** (`npm run hub -- --help`):

| Option | Environment | Default |
| --- | --- | --- |
| `--port` | `HUB_PORT` | 8443 (HTTPS + WebSocket) |
| `--http-port <n\|off>` | `HUB_HELPER_PORT` | 8080 (certificate-install page) |
| `--host` | `HUB_HOST` | 0.0.0.0 |
| `--names a,b` | `HUB_EXTRA_NAMES` | extra DNS names / IPs for the certificate |
| `--no-mkcert`, `--no-tls` | `HUB_MKCERT=0`, `HUB_TLS=0` | mkcert if installed; TLS on |
| `--static`, `--data`, `--certs` | `HUB_STATIC_DIR`, `HUB_DATA_DIR`, `HUB_CERT_DIR` | `app/dist`, `hub/data`, `hub/.certs` |
| `--fresh` | `HUB_FRESH=1` | keep the saved snapshot |
| `--pin <code>` | `HUB_PIN` | none: anyone on the network can sync. With a PIN (4-32 letters, digits, `-`, `_`) the hub prints `https://<ip>:8443/?pin=<code>`; a phone opens that once and the app remembers it (Debug > Hub PIN to change it). Without it, the phone says "The hub needs the event PIN" |
| `--quiet`, `--verbose` | `HUB_LOG` | info |

**Fake device** (`npm run fake-device -- ...`): `--url`, `--ca`, `--pin <code>` (or `HUB_PIN`), `--rate <hazards/s>`, `--devices <n>`, `--spots <n>`, `--jitter <m>`, `--center <lat,lon>`, `--seed`, `--count`. It verifies the hub's certificate against `hub/.certs/lubak-hub-ca.crt`; `--insecure` exists but is opt-in and warns.

Nothing in this repository is secret. TLS private keys are generated on the laptop into `hub/.certs/` (git-ignored); the app has no API keys. Do not commit that folder, `hub/data/`, `.env*` files or `model/work/`.

## Who owns what

Fill in the names. Each owner has a folder they can change freely and a contract they must not break without telling the others.

| | Owner | Area | Folders and files | Contract with the others |
| --- | --- | --- | --- | --- |
| 1 | _name_ | **Model** | `model/`, `app/public/models/lubak.onnx` | The ONNX shape and class order above; the per-class thresholds handed to owner 2 |
| 2 | _name_ | **Camera + detection pipeline** | `app/src/camera.ts`, `detector.ts`, `confirmer.ts`, `sensors.ts`, `pipeline.ts` | Emits confirmed hazards through `createHazard()` into the store; reads the model contract |
| 3 | _name_ | **Hub + sync** | `hub/`, `shared/`, `app/src/sync.ts`, `app/src/store.ts` | `shared/` is the agreement between every phone and the hub: change it for everyone, with tests |
| 4 | _name_ | **Map UI + demo** | `app/src/map.ts`, `ui/`, `style.css`, `demo.ts`, `app/public/tiles/` | Reads hazards from the store only; Demo Mode must keep going through the real pipeline |

**1. Model.** Today: a baseline trained on public pothole and crack photos is committed, with its numbers in `model/RESULTS.md`; no flood data, no local data.
First: (1) record the phone mount on Antipolo roads and label a few hundred frames (potholes, cracks, flooded and wet-but-passable stretches, plain road); (2) fold them in with `model/datasets.py` (`add_yolo_folder`), retrain (`model/README.md`), export, and run `model/tools/evaluate_onnx.py` on val then test; (3) update `model/RESULTS.md` and the thresholds in `app/src/confirmer.ts`, regenerate the parity fixture, run `npm test` and `npm run rehearse`.

**2. Camera + detection pipeline.** Today: works with the mock and with any contract-conforming ONNX; thresholds are placeholders; untested on real phones.
First: (1) on a real Android phone read the Debug screen while driving the app against a screen showing road footage: backend, ms per stage, capture fps, GPS accuracy, jolt readings; (2) put owner 1's thresholds into `DEFAULT_CONFIRMER_CONFIG` and calibrate the jolt threshold and boost with real rides on a motorbike and a jeep (`lookaheadM` in `pipeline.ts` is off by default: the camera sees a pothole before the wheel hits it); (3) try Safari on an iPhone: motion permission flow, camera orientation, wake lock, and whether WASM is fast enough there.

**3. Hub + sync.** Today: converges under shuffled, duplicated and delayed delivery in tests; never run with real phones on a real hotspot.
First: (1) run the hub on the real hotspot with two or more phones and rehearse the failures: kill and restart the hub mid-drive, switch a phone's Wi-Fi off and on, change the laptop's address; (2) load it: `npm run fake-device -- --rate 50 --devices 20`, watch memory and the rate limits, check behaviour with a phone whose clock is off; (3) decide on authentication (a shared event PIN in `hello`?), and on merging a hazard that straddles a geohash cell border.

**4. Map UI + demo.** Today: markers, legend, count badge, offline banner, three screens, Demo Mode all work with placeholder tiles.
First: (1) render real offline tiles for the demo area (QGIS recipe in `app/public/tiles/README.md`, no bulk downloads from tile.openstreetmap.org), check the size of `app/dist`, and agree how to share them because `app/public/tiles/*/` is git-ignored; (2) rehearse the pitch with Demo Mode on two phones and record a fallback video; make the Drive screen readable at arm's length in sunlight; (3) improve the Map screen: clustering at low zoom, a popup with confirmations and "last seen", class filter, follow-me, and a check with about 1,000 hazards from the fake device.

## Offline demo checklist

**Before the day (with internet)**

- [ ] `npm install`, `npm test` and `npm run typecheck` are green on the demo laptop, and **`npm run rehearse` passes every check** (two emulated phones, the real hub and model: [`DEMO.md`](DEMO.md)).
- [ ] `python model/export_onnx.py --verify app/public/models/lubak.onnx` prints OK. Debug will show `ONNX webgpu` or `ONNX wasm`, not MOCK.
- [ ] If the demo is somewhere other than Antipolo: render tiles for it and trace a demo loop there ([`app/public/tiles/README.md`](app/public/tiles/README.md)).
- [ ] `npm run build`; the *precache N entries* line: about 53 MB (app, model, onnxruntime WASM, tiles), about 32 MB over the wire because the hub gzips the WASM; each phone downloads it once over the hotspot.
- [ ] Full rehearsal on the real hotspot with at least two phones, including a hub restart and a "Pothole ahead" warning on the second phone.
- [ ] Fallback: Demo Mode works, and [`docs/demo-mode-fallback.webm`](docs/demo-mode-fallback.webm) plays. Charged phones, power banks, secure mounts.

**At the venue**

- [ ] Uplink off (unplug, or disable the laptop's internet). Phones: **mobile data off**.
- [ ] Start the hub (`npm run hub -- --fresh --pin <event-pin>`), note the URL, and **do not toggle the laptop's Wi-Fi** (the address is part of the app's identity).
- [ ] Each phone: join the network → `http://<ip>:8080` → install the certificate → open the `https://<ip>:8443/?pin=...` address the hub printed, without a warning → Install app / Add to Home Screen.
- [ ] Debug → **Offline ready: yes, cached**. Camera, precise location and motion allowed. Detector is not MOCK.
- [ ] Debug → **Clear hazards on this phone** on every phone that was used in rehearsal.
- [ ] Drive → Start, point at a road photo or video: boxes appear, a confirmation vibrates, the hazard shows on Map.
- [ ] A confirmation on phone A appears on phone B within a second or two; both confirming the same spot shows x2.
- [ ] Phone B, Started and moving towards (or standing at) the spot phone A reported: **"Pothole ahead"** banner, beeps, vibration.
- [ ] Stop the hub: phones keep working, the banner changes, new hazards show *Waiting to sync*. Start it again: they reconnect and catch up.
- [ ] Close the app, switch the phone to airplane mode (Wi-Fi off), reopen from the Home Screen icon: the app, the map and its hazards are all there.
- [ ] Demo Mode works on both phones, in case it is needed.

## Known limitations

* **Accuracy is measured on public photos only** ([`model/RESULTS.md`](model/RESULTS.md)): what the model does on Antipolo roads from a handlebar mount is unmeasured until somebody records and labels such footage. It does not detect flooded roads at all.
* A hazard is placed where the *phone* is when it confirms, not where the camera saw it, so markers sit a few metres before the real thing. A geohash-8 cell is about 37 m × 19 m near Antipolo: two close potholes of one kind share a hazard, and one on a cell border can become two. There is no neighbour-cell merge.
* Access control is a **shared event PIN** (`npm run hub -- --pin <code>`), off by default: without it anyone on the hotspot can read and post hazards, with it only phones that were given the PIN can. It is one secret for everybody, sent over the hub's TLS, not per-user accounts. Hazards carry a location and a random per-install device id (it identifies an install, not a person); the hub snapshot (`hub/data/`, git-ignored) holds them.
* Phone clocks should roughly agree: the hub rejects hazards stamped more than 10 minutes in the future, and ages on the map depend on the clocks.
* Hazards expire by time only (flooded road 6 hours, pothole and crack 21 days). There is no "repaired" message.
* A web page cannot keep the camera and GPS running with the screen off or in the background. The phone must stay unlocked in the foreground (the app asks for a screen wake lock where the browser allows it).
* WebGPU depends on the phone's browser and GPU; WASM is the fallback and is slower (single-threaded: the hub does not enable cross-origin isolation, see the note in `hub/src/hub.ts`). In the rehearsal, WASM on a laptop CPU takes about 130 ms a frame; neither has been timed on a phone yet.
* This is not a safety system. Do not operate the phone while riding; mount it securely and let a passenger run demos.

## Credits and licences of what the app ships

| part | source | licence / what it asks of you |
| --- | --- | --- |
| Map tiles (`app/public/tiles`) | © OpenStreetMap contributors, published by the Overture Maps Foundation, rendered by `app/scripts/offline_tiles.py` | ODbL 1.0: keep the attribution the map shows |
| Pothole training images | Atikur Rahman Chitholian's pothole dataset (via Roboflow) | ODbL 1.0: the model is a Produced Work; credit the dataset |
| Crack training images | Roboflow Universe `university-bswxt/crack-bphdr`, packaged by Ultralytics as `crack-seg` | Public Domain Mark 1.0 according to Ultralytics' dataset page |
| Model architecture, pretrained weights, training code | Ultralytics YOLOv8 (`yolov8n.pt`) | **AGPL-3.0**: `lubak.onnx` is fine-tuned from it, so serving or distributing it to others carries AGPL obligations (or needs an Ultralytics Enterprise licence). This repository has no licence file yet: the owners should choose one with that in mind |
| Inference runtime, map library | onnxruntime-web, Leaflet | MIT, BSD-2-Clause |

## Working on the code

* TypeScript is strict everywhere; `npm run typecheck` covers `shared`, `hub`, `app` and the root tests. Tests live in each package's `test/` folder, and `test/` at the root holds the one that crosses all of them: `test/flowchart.test.ts` walks the flowchart box by box with the real code on both sides of every arrow (`npm test` runs everything; `npm run test:watch` while developing). If it fails, the code stopped doing what [`docs/flowchart.md`](docs/flowchart.md) says: fix the code, or change the chart on purpose. The model scripts have their own: `python -m unittest discover -s model/tests`.
* `shared/` has no dependencies and runs in browsers and Node. If you change it, both sides change: run everything.
* Keep the debugging surface in the Debug screen up to date when you add a stage to the pipeline; it is how everyone else sees what you built.
* Before committing: no private keys, no `dist/`, no downloaded datasets, no test ONNX files. The `.gitignore` covers the usual suspects; check `git status`.
