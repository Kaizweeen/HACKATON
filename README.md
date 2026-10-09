# Lubak Alert

Offline-first PWA that runs a YOLOv8n ONNX model **in the browser** to spot potholes, road cracks and flooded roads from a phone mounted on a motorbike or jeep,
confirms detections with the accelerometer and GPS, and shares confirmed hazards with other phones through a local hub over a hotspot — no internet needed.
AppBuildersPH Hackathon 2026, theme: Local AI.

> This README grows with each build stage. Current state: **stage 3 — shared contract, hub, and the PWA with the mock detector, map, sync and demo mode.** The real ONNX detector is the next stage.

```
shared/   TypeScript types, merge function, expiry, WebSocket protocol  (imported by app and hub)
hub/      Node + TypeScript WebSocket/HTTPS server, plus tools/fake-device
app/      Vite + plain TypeScript PWA (camera, detector, confirmer, sensors, store, sync, map)
model/    YOLOv8n training / export notes                                (coming in stage 4)
```

## Try it

Needs Node 22.12 or newer.

```bash
npm install
npm test            # shared, hub and app unit + integration tests
npm run typecheck
npm run build       # builds the PWA into app/dist
npm run hub         # HTTPS + WebSocket hub: generates a certificate on first run, prints the LAN URL
npm run fake-device # in another terminal: emits hazards along a test route near Antipolo, no camera needed
npm run dev         # hub + live-reloading app together (https://localhost:5173)
```

Read [`shared/README.md`](shared/README.md) first: it is the agreement between phones and hub.
