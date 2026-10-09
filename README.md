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

## Status: what runs today, and what is a stub

**Runs and is tested**

* `shared/`: the hazard record, `mergeHazard` (commutative, associative, idempotent), expiry, the WebSocket protocol. Property-style tests with seeded random cases and replica-convergence simulations.
* `hub/`: HTTPS + WebSocket server, local certificate authority (mkcert if installed), in-memory store with a JSON snapshot every 10 s, expiry sweep, rate limits, and a fake-device tool. Integration tests run over real TLS.
* `app/`: Drive, Map and Debug screens; camera → detector → confirmer pipeline; DeviceMotion jolts and GPS; IndexedDB store; reconnecting sync client; Leaflet map; service worker; Demo Mode.
  Exercised in headless Chromium with a fake camera: hazards from the fake device show up on the map, two tabs stay in sync, and a reload with the network cut still opens the app.
* The real inference path: onnxruntime-web (WebGPU, falling back to WASM), 320 px letterbox, YOLOv8 output decoding, class-aware NMS written in TypeScript. Checked against Ultralytics' own NMS on an **untrained** 3-class YOLOv8n export (identical detections, boxes within 0.005 px).
* `model/`: converters, export-and-verify script, evaluation script, Colab notebook outline. Python unit tests pass.

**Stub, placeholder or not done**

* **There is no trained model.** `app/public/models/lubak.onnx` does not exist and **this repository contains no accuracy figure of any kind**. Until the file exists the app uses the `MockDetector` (random boxes) and shows a red **MOCK** badge on the Drive screen. Never commit a test model under that name.
* Confirmer settings are **placeholders chosen without data**: per-class thresholds (pothole 0.45, crack 0.40, flooded 0.50), jolt threshold 4 m/s², jolt boost +0.15, 3 consecutive frames, 5 s cooldown. Tune them with real footage.
* Map tiles: only a generator for blank hatched placeholder tiles exists. Real offline tiles for the demo area still have to be rendered ([`app/public/tiles/README.md`](app/public/tiles/README.md)).
* **Not yet tried on a physical phone, camera mount, hotspot, GPS, or a real GPU's WebGPU**, and not on iOS at all. Android and iPhone instructions below are written from the platforms' documented behaviour and the helper page; menu names vary. Expect to adjust.
* No authentication on the hub, no way to mark a hazard as repaired (hazards only expire), no audio alerts (a short vibration on confirmation).

## Repository layout

```text
shared/   TypeScript contract: types, merge, expiry, geohash, WebSocket messages. Imported by hub and app. Start here: shared/README.md
hub/      Node + TypeScript server (express, ws, HTTPS), tools/fake-device
app/      Vite + plain TypeScript PWA: camera, detector, confirmer, sensors, store, sync, map, screens, demo
model/    YOLOv8n training notebook, dataset conversion, ONNX export + verification, evaluation. Start here: model/README.md
test/     the flowchart as a test: the real app code talking to the real hub, in one process
docs/     flowchart.md: the flowchart and the architecture as diagrams, mapped to code and tests
scripts/  dev.mjs (hub + app dev server together)
```

## Quick start on one computer (no phone needed)

Needs **Node 22.12 or newer**. Python is only needed for `model/`.

```bash
npm install
npm test               # shared, hub and app unit + integration tests
npm run typecheck
npm run build          # type-checks, then builds the PWA into app/dist
npm run hub            # HTTPS + WebSocket hub: makes a certificate on first run, prints the LAN URL
npm run fake-device    # in a second terminal: fake phones driving a test route near Antipolo (14.585, 121.176)
```

**Shortcut: `npm run demo`** builds the app, adds placeholder map tiles if you have none, and starts the hub with an empty store. The rehearsal script is in [`DEMO.md`](DEMO.md).

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
| `--quiet`, `--verbose` | `HUB_LOG` | info |

**Fake device** (`npm run fake-device -- ...`): `--url`, `--ca`, `--rate <hazards/s>`, `--devices <n>`, `--spots <n>`, `--jitter <m>`, `--center <lat,lon>`, `--seed`, `--count`. It verifies the hub's certificate against `hub/.certs/lubak-hub-ca.crt`; `--insecure` exists but is opt-in and warns.

Nothing in this repository is secret. TLS private keys are generated on the laptop into `hub/.certs/` (git-ignored); the app has no API keys. Do not commit that folder, `hub/data/`, `.env*` files or `model/work/`.

## Who owns what

Fill in the names. Each owner has a folder they can change freely and a contract they must not break without telling the others.

| | Owner | Area | Folders and files | Contract with the others |
| --- | --- | --- | --- | --- |
| 1 | _name_ | **Model** | `model/`, `app/public/models/lubak.onnx` | The ONNX shape and class order above; the per-class thresholds handed to owner 2 |
| 2 | _name_ | **Camera + detection pipeline** | `app/src/camera.ts`, `detector.ts`, `confirmer.ts`, `sensors.ts`, `pipeline.ts` | Emits confirmed hazards through `createHazard()` into the store; reads the model contract |
| 3 | _name_ | **Hub + sync** | `hub/`, `shared/`, `app/src/sync.ts`, `app/src/store.ts` | `shared/` is the agreement between every phone and the hub: change it for everyone, with tests |
| 4 | _name_ | **Map UI + demo** | `app/src/map.ts`, `ui/`, `style.css`, `demo.ts`, `app/public/tiles/` | Reads hazards from the store only; Demo Mode must keep going through the real pipeline |

**1. Model.** Today: pipeline, checks and notebook exist; no weights, no numbers.
First: (1) run the notebook on real RDD2022 plus flood images you are licensed to use, and add photos from the actual phone mount on Antipolo roads; (2) export with `model/export_onnx.py`, drop the file in `app/public/models/`, generate the parity reference (`model/tools/parity_ref.py`) and run `npm test`; (3) fill in `model/RESULTS.md` with what *you* measured, choose per-class thresholds from `model/evaluate.py` output, and give them to owner 2.

**2. Camera + detection pipeline.** Today: works with the mock and with any contract-conforming ONNX; thresholds are placeholders; untested on real phones.
First: (1) on a real Android phone read the Debug screen while driving the app against a screen showing road footage: backend, ms per stage, capture fps, GPS accuracy, jolt readings; (2) put owner 1's thresholds into `DEFAULT_CONFIRMER_CONFIG` and calibrate the jolt threshold and boost with real rides on a motorbike and a jeep (`lookaheadM` in `pipeline.ts` is off by default: the camera sees a pothole before the wheel hits it); (3) try Safari on an iPhone: motion permission flow, camera orientation, wake lock, and whether WASM is fast enough there.

**3. Hub + sync.** Today: converges under shuffled, duplicated and delayed delivery in tests; never run with real phones on a real hotspot.
First: (1) run the hub on the real hotspot with two or more phones and rehearse the failures: kill and restart the hub mid-drive, switch a phone's Wi-Fi off and on, change the laptop's address; (2) load it: `npm run fake-device -- --rate 50 --devices 20`, watch memory and the rate limits, check behaviour with a phone whose clock is off; (3) decide on authentication (a shared event PIN in `hello`?), and on merging a hazard that straddles a geohash cell border.

**4. Map UI + demo.** Today: markers, legend, count badge, offline banner, three screens, Demo Mode all work with placeholder tiles.
First: (1) render real offline tiles for the demo area (QGIS recipe in `app/public/tiles/README.md`, no bulk downloads from tile.openstreetmap.org), check the size of `app/dist`, and agree how to share them because `app/public/tiles/*/` is git-ignored; (2) rehearse the pitch with Demo Mode on two phones and record a fallback video; make the Drive screen readable at arm's length in sunlight; (3) improve the Map screen: clustering at low zoom, a popup with confirmations and "last seen", class filter, follow-me, and a check with about 1,000 hazards from the fake device.

## Offline demo checklist

**Before the day (with internet)**

- [ ] `npm install`, `npm test` and `npm run typecheck` are green on the demo laptop.
- [ ] `app/public/models/lubak.onnx` is there and `python model/export_onnx.py --verify app/public/models/lubak.onnx` prints OK. Debug will show `ONNX webgpu` or `ONNX wasm`, not MOCK.
- [ ] Real tiles for the route are in `app/public/tiles/` (not the placeholders), with the right attribution.
- [ ] `npm run build`; the *precache N entries* line is a size you can live with on the hotspot.
- [ ] Full rehearsal on the real hotspot with at least two phones, including a hub restart.
- [ ] A recorded video of Demo Mode working, as a fallback. Charged phones, power banks, secure mounts.

**At the venue**

- [ ] Uplink off (unplug, or disable the laptop's internet). Phones: **mobile data off**.
- [ ] Start the hub (`npm run hub -- --fresh`), note the URL, and **do not toggle the laptop's Wi-Fi** (the address is part of the app's identity).
- [ ] Each phone: join the network → `http://<ip>:8080` → install the certificate → `https://<ip>:8443` opens without a warning → Install app / Add to Home Screen.
- [ ] Debug → **Offline ready: yes, cached**. Camera, precise location and motion allowed. Detector is not MOCK.
- [ ] Debug → **Clear hazards on this phone** on every phone that was used in rehearsal.
- [ ] Drive → Start, point at a road photo or video: boxes appear, a confirmation vibrates, the hazard shows on Map.
- [ ] A confirmation on phone A appears on phone B within a second or two; both confirming the same spot shows x2.
- [ ] Stop the hub: phones keep working, the banner changes, new hazards show *Waiting to sync*. Start it again: they reconnect and catch up.
- [ ] Close the app, switch the phone to airplane mode (Wi-Fi off), reopen from the Home Screen icon: the app, the map and its hazards are all there.
- [ ] Demo Mode works on both phones, in case it is needed.

## Known limitations

* **No accuracy claims exist.** Whatever the model does on real roads is unmeasured until somebody measures it and writes it in `model/RESULTS.md`.
* A hazard is placed where the *phone* is when it confirms, not where the camera saw it, so markers sit a few metres before the real thing. A geohash-8 cell is about 37 m × 19 m near Antipolo: two close potholes of one kind share a hazard, and one on a cell border can become two. There is no neighbour-cell merge.
* The hub has **no authentication**: anyone on the hotspot can read and post hazards. Fine for a demo, not for deployment. Hazards carry a location and a random per-install device id (it identifies an install, not a person); the hub snapshot (`hub/data/`, git-ignored) holds them.
* Phone clocks should roughly agree: the hub rejects hazards stamped more than 10 minutes in the future, and ages on the map depend on the clocks.
* Hazards expire by time only (flooded road 6 hours, pothole and crack 21 days). There is no "repaired" message.
* A web page cannot keep the camera and GPS running with the screen off or in the background. The phone must stay unlocked in the foreground (the app asks for a screen wake lock where the browser allows it).
* WebGPU depends on the phone's browser and GPU; WASM is the fallback and is slower. Neither has been timed on a phone yet.
* This is not a safety system. Do not operate the phone while riding; mount it securely and let a passenger run demos.

## Working on the code

* TypeScript is strict everywhere; `npm run typecheck` covers `shared`, `hub`, `app` and the root tests. Tests live in each package's `test/` folder, and `test/` at the root holds the one that crosses all of them: `test/flowchart.test.ts` walks the flowchart box by box with the real code on both sides of every arrow (`npm test` runs everything; `npm run test:watch` while developing). If it fails, the code stopped doing what [`docs/flowchart.md`](docs/flowchart.md) says: fix the code, or change the chart on purpose. The model scripts have their own: `python -m unittest discover -s model/tests`.
* `shared/` has no dependencies and runs in browsers and Node. If you change it, both sides change: run everything.
* Keep the debugging surface in the Debug screen up to date when you add a stage to the pipeline; it is how everyone else sees what you built.
* Before committing: no private keys, no `dist/`, no downloaded datasets, no test ONNX files. The `.gitignore` covers the usual suspects; check `git status`.
