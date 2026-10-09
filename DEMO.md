# Demo runbook

Two ways to show Lubak Alert. Do the first on any laptop today; the second needs the model and tiles listed at the bottom.

## A. Demo Mode (no camera, no model, no GPS needed)

```bash
npm install
npm run demo          # placeholder tiles if none, build, hub with an empty store
```

1. Open the HTTPS address the hub prints on every phone (install the certificate first: README, "Trusting the certificate").
2. **Drive** tab → turn **Demo mode** on → **Start**. A scripted 60-second drive with ten encounters runs through the real confirmer, store, sync and map. Eight hazards confirm; two (a too-short blip, a stretch below threshold) are rejected.
3. **Map** tab: eight markers appear along the route. On two phones running it, shared spots show **x2** and each phone sees the other's markers.
4. Resilience, in this order: stop the hub (banner changes, new hazards say *Waiting to sync*) → start it → they catch up. Then close the app, turn Wi-Fi off, reopen from the home-screen icon: app, map and hazards are all there.

Say out loud that this is a scripted rehearsal drive (everything on screen is labelled DEMO), not a measurement.

`npm run fake-device` in a second terminal adds hazards from other "riders" while you talk.

## B. Real detection (still to be done)

Not possible until these exist; the app tells the truth until then (red **MOCK** badge, never a silent fake):

- [ ] `app/public/models/lubak.onnx`: train with `model/README.md`, then `python model/export_onnx.py --verify app/public/models/lubak.onnx`.
- [ ] Per-class thresholds from `model/evaluate.py` into `DEFAULT_CONFIRMER_CONFIG`.
- [ ] Real offline tiles for the route (`app/public/tiles/README.md`). Without them the map shows placeholder grid tiles with correct marker positions.
- [ ] One rehearsal on a physical phone, mount and hotspot (README, "Offline demo checklist").
