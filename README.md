# Lubak Alert

Offline-first PWA that runs a YOLOv8n ONNX model **in the browser** to spot potholes, road cracks and flooded roads from a phone mounted on a motorbike or jeep,
confirms detections with the accelerometer and GPS, and shares confirmed hazards with other phones through a local hub over a hotspot — no internet needed.
AppBuildersPH Hackathon 2026, theme: Local AI.

> This README grows with each build stage. Current state: **stage 1 — shared contract.**

```
shared/   TypeScript types, merge function, expiry, WebSocket protocol  (imported by app and hub)
hub/      Node + TypeScript WebSocket/HTTPS server                      (coming in stage 2)
app/      Vite + plain TypeScript PWA                                    (coming in stage 3)
model/    YOLOv8n training / export notes                                (coming in stage 4)
```

## Try it

Needs Node 22.12 or newer.

```bash
npm install
npm test          # shared contract tests (merge laws, expiry, protocol, convergence simulation)
npm run typecheck
```

Read [`shared/README.md`](shared/README.md) first: it is the agreement between phones and hub.
