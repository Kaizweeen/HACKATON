# `lubak.onnx`

**`app/public/models/lubak.onnx` is the trained model** (`lubak_public_v1`: YOLOv8n fine-tuned on public pothole and crack
photos, sha256 `0e91a786...`). How it was made and what it measured: [`model/RESULTS.md`](../../../model/RESULTS.md). It is
served as `/models/lubak.onnx`, precached by the service worker (so the app works with no connection) and loaded by
`app/src/detector.ts`.

If the file is missing or unreadable the app falls back to the `MockDetector` (random boxes) and says so with a red **MOCK**
badge on the Drive screen. Never commit a dummy or test model under this name: the app would present its output as real
detections. Replacing it means: retrain, export with `model/export_onnx.py` (it writes here and verifies the contract), re-run
`model/tools/evaluate_onnx.py`, update `model/RESULTS.md` and the thresholds in `app/src/confirmer.ts`, regenerate
`app/test/fixtures/parity` with `model/tools/parity_ref.py`.

## What the app expects from the file

| | |
| --- | --- |
| Input | `images`, float32, `[1, 3, 320, 320]`, RGB, scaled 0..1, letterboxed (grey 114) |
| Output | float32 `[1, 7, N]` = `[1, 4 + 3 classes, N]`; N = 2100 for a 320 px YOLOv8 head. Rows 0-3 are `cx, cy, w, h` in input pixels, rows 4-6 are class scores (already sigmoid) |
| Classes (in this order) | `0 pothole`, `1 crack`, `2 flooded_road`. This order is `HAZARD_CLASSES` in `shared/src/hazard.ts` |
| Opset / precision | opset 12 to 17, fp32 (fp16 is an optimisation to try later) |
| Size | about 12 MB for YOLOv8n; keep it under ~25 MB so the first hotspot download stays quick |

The app checks the output shape on load and fails loudly (not silently) if the class count does not match.

## How to produce it

See [`model/README.md`](../../../model/README.md): it reproduces this model from public data on a laptop, and explains how to
add your own (road footage from the phone mount, flood images), then `model/export_onnx.py` writes the file straight here.

## Handy overrides while testing

* `?model=/models/other.onnx` on the app URL loads a different file without touching this one.
* `?detector=mock` forces the mock, `?detector=onnx` refuses to fall back (shows the load error instead).
* After replacing the file, use **Debug → Reset app cache & reload** on each phone: the old copy is precached.
