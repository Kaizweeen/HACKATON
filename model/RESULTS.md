# Model results: `lubak_public_v1`

> Every number below came from the run described here, on the split named next to it, at 320 px. **They are measured on public
> photos, not on Antipolo roads seen from a handlebar mount**: treat them as a sanity check of the pipeline, not as the accuracy
> the app will have on the street. Do not quote a number without its split and this caveat.

## Weights

| | |
| --- | --- |
| File | `app/public/models/lubak.onnx` (12.14 MB, opset 12, input `[1,3,320,320]`, output `[1,7,2100]`) |
| SHA-256 | `0e91a786b83a71229b232734655a6b2d9d94402251a04f80831adb11f45d1e16` |
| Trained from | `yolov8n.pt` (COCO), Ultralytics release asset v8.4.0, sha256 `f59b3d833e2ff32e194b5bb8e08d211dc7c5bdf144b90d2c8412c47ccfc83b36` |
| Training | `yolo detect train model=yolov8n.pt data=work/dataset/data.yaml imgsz=320 epochs=60 patience=20 batch=32 workers=3 cache=ram device=cpu seed=0 deterministic=True` (full command in [`README.md`](README.md)); best epoch 60 of 60 by Ultralytics' fitness on `val` |
| Software | Ultralytics 8.4.174, PyTorch 2.14.1 (CPU), onnx 1.23.2, onnxruntime 1.31.0, onnxslim 0.1.98, Python 3.13 |
| Hardware / time | 4-core Intel Xeon @ 2.1 GHz, no GPU; 1.5 hours for 60 epochs (about 90 s an epoch) |
| Date | 2026-10-09 |

## Data

Built by [`tools/build_public_dataset.py`](tools/build_public_dataset.py); each source keeps its published split, so `test` was
never used for training or for choosing anything.

| split | images | pothole boxes | crack boxes | flooded_road boxes |
| --- | --- | --- | --- | --- |
| train | 1665 | 1256 | 1572 | 0 |
| val | 333 | 330 | 249 | 0 |
| test | 179 | 153 | 148 | 0 |

| source | what we used | licence / terms | split |
| --- | --- | --- | --- |
| Pothole dataset by Atikur Rahman Chitholian (Roboflow export `brad-dwyer/pothole-voxrl` v1, GitLab mirror `ykristian/potholedataset` @ `54a2c06b`) | all 665 road photos, 1 class -> `pothole` | ODbL v1.0 (attribution; the model is a Produced Work) | published 465 / 133 / 67 |
| Ultralytics `crack-seg` (GitHub release asset, sha256 pinned in the builder) | 1200 of 3717 train images (seeded sample), all 200 val, all 112 test; polygons -> boxes; 1 class -> `crack` | Public Domain Mark 1.0 according to Ultralytics' dataset page (docs.ultralytics.com/datasets/segment/crack-seg); originally Roboflow Universe `university-bswxt/crack-bphdr` (2022) | published train / val / test |
| Flooded roads | **none** | | |
| Own photos / video frames from the phone mount | **none yet** | | |

What the data is not: the crack images are mostly close-ups of cracked concrete and walls, not a road ahead seen from a
vehicle; the pothole photos are mostly from other countries; nothing is from the Philippines or from the phone mount.

## Metrics

### mAP (Ultralytics `val`, best.pt, IoU 0.5 and 0.5:0.95)

| split | images | mAP50 all | mAP50 pothole | mAP50 crack | mAP50-95 all | mAP50-95 pothole | mAP50-95 crack |
| --- | --- | --- | --- | --- | --- | --- | --- |
| val | 333 | 0.740 | 0.724 | 0.756 | 0.490 | 0.438 | 0.543 |
| **test** | 179 | **0.693** | **0.740** | **0.646** | 0.453 | 0.459 | 0.448 |

`val` picked the best epoch (60 of 60), so its numbers are slightly optimistic; `test` was used once, at the end.

### Precision / recall of the exported ONNX, through the app's own letterbox + NMS ([`tools/evaluate_onnx.py`](tools/evaluate_onnx.py))

Thresholds were chosen on **val** as the lowest confidence where per-box precision is at least 0.8, then measured on **test**:

| class | threshold (from val) | val precision / recall | **test precision / recall** | test TP / FP / FN boxes |
| --- | --- | --- | --- | --- |
| pothole | 0.40 | 0.825 / 0.627 | **0.806 / 0.680** | 104 / 25 / 49 |
| crack | 0.25 | 0.830 / 0.743 | **0.720 / 0.642** | 95 / 37 / 53 |
| flooded_road | none (no data) | no box at or above 0.25 | no box at or above 0.25 | |

The whole curve on **test** (for choosing differently later; do not pick from it and then quote it as a test result):

| threshold | pothole precision | pothole recall | crack precision | crack recall |
| --- | --- | --- | --- | --- |
| 0.25 | 0.721 | 0.725 | 0.720 | 0.642 |
| 0.30 | 0.750 | 0.706 | 0.740 | 0.635 |
| 0.35 | 0.777 | 0.706 | 0.756 | 0.628 |
| 0.40 | 0.806 | 0.680 | 0.786 | 0.622 |
| 0.45 | 0.840 | 0.654 | 0.818 | 0.608 |
| 0.50 | 0.841 | 0.621 | 0.817 | 0.574 |
| 0.60 | 0.854 | 0.575 | 0.835 | 0.514 |
| 0.70 | 0.890 | 0.477 | 0.831 | 0.331 |

Crack precision drops from 0.83 on val to 0.72 on test: val was used to choose the epoch and the thresholds, and both splits are
small (199 and 112 crack photos), so a difference this size is not surprising. Cracks are the class to treat with the most caution.

Per photo, at those thresholds, on **test**:

| class | threshold | photos that show one: detected | photos without one: a false box anyway |
| --- | --- | --- | --- |
| pothole | 0.40 | **62 of 67 (92.5 %)** (val: 124 of 133, 93.2 %) | 0 of 112 (0 %) (val: 4 of 200, 2.0 %) |
| crack | 0.25 | **92 of 112 (82.1 %)** (val: 182 of 199, 91.5 %) | 0 of 67 (0 %) (val: 1 of 134, 0.7 %) |

The "photos without one" for potholes are the crack close-ups and vice versa, so the false-alarm column says little about real
streets (no plain-road negatives were available).

## In the app

| | |
| --- | --- |
| Thresholds (`DEFAULT_CONFIRMER_CONFIG.thresholds`, `app/src/confirmer.ts`) | pothole 0.40, crack 0.25 (from val, see above); flooded_road 0.5 (the live model never reaches it; it matters for Demo Mode) |
| Floor | the detector drops every box under 0.25 before the confirmer |
| Confirmation | 3 consecutive processed frames at or above the class threshold, then a 5 s per-class cooldown |
| Parity with Ultralytics | identical detections (classes, scores, boxes within 0.05 px) on raw outputs of this model: `app/test/fixtures/parity`, run by `npm test` |
| Speed, rehearsal (Chromium, WASM, single thread, laptop CPU shared with other work) | onnxruntime-web WASM, single thread, headless Chromium on the 4-core Xeon above: about 105 ms average, 150 ms p95 per frame including preprocessing (`npm run rehearse`, fake camera at 5 fps, 98 % of frames processed) |
| Speed on phones | **not measured yet**: record Debug > Inference time and backend per phone here |

| phone | browser | backend (webgpu / wasm) | inference ms (avg / p95) | processed fps |
| --- | --- | --- | --- | --- |
| TBD | TBD | TBD | TBD | TBD |

## Known failure modes and gaps

* **Flooded road is never detected.** No labelled flood images, so the class head only learned "not a flood"; on val and test it produced no flooded_road box at or above the app's 0.25 floor, so it neither finds floods nor invents them on these photos.
* Cracks are the weak class: thin, low-contrast, and the training crops are close-ups unlike the road ahead.
* Small, far potholes are often missed per box (see recall); the app only needs one of the 3 frames' boxes per frame, and the
  phone gets closer every frame, which helps.
* Puddles, shadows, manhole covers and patched asphalt were not specifically represented as negatives.
* Next data to add, in order of value: frames from the real mount on Antipolo roads (labelled), flooded and wet-but-passable
  roads, and plain-road negatives.
