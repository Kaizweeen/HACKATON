# Model results (fill this in; leave a cell "TBD" until YOU measured it)

> Nothing in this file has been measured yet. **Do not put a number here, in the README, on a slide or in the pitch unless it came from a run you can
> point to** (weights hash, split, image size, date). A figure from another split, another image size or an earlier run is not a result.
> It is fine, and honest, to say "we have not measured this yet".

## Weights

| | |
| --- | --- |
| File | `app/public/models/lubak.onnx` |
| SHA-256 | TBD (printed by `python model/export_onnx.py`) |
| Trained from | TBD (e.g. `yolov8n.pt`, Ultralytics version) |
| Training command / notebook commit | TBD |
| Date | TBD |

## Data (counts from `datasets.class_histogram`, sources and licences)

| split | images | pothole boxes | crack boxes | flooded_road boxes |
| --- | --- | --- | --- | --- |
| train | TBD | TBD | TBD | TBD |
| val | TBD | TBD | TBD | TBD |

| source | what we used | licence / terms | how it was split |
| --- | --- | --- | --- |
| RDD2022 | TBD (which countries) | TBD | contiguous blocks (see `datasets.split_by_blocks`) |
| Flood images | TBD | TBD | TBD |
| Own photos / video frames | TBD | TBD | TBD |

## Validation metrics (IoU 0.5, validation split above, 320 px)

Produce with the evaluation cells in the notebook (`yolo val` for mAP, `model/evaluate.py` for precision / recall at the thresholds below).

| class | mAP50 | threshold chosen for the app | precision at it | recall at it |
| --- | --- | --- | --- | --- |
| pothole | TBD | TBD | TBD | TBD |
| crack | TBD | TBD | TBD | TBD |
| flooded_road | TBD | TBD | TBD | TBD |

These thresholds go into `DEFAULT_CONFIRMER_CONFIG.thresholds` in `app/src/confirmer.ts`. The app additionally requires 3 consecutive frames per
confirmation, so the end-to-end false-alarm rate is lower than the per-frame precision above; measure that on a real drive instead of assuming it.

## Parity with Ultralytics (does the app read the model the way you validated it?)

| check | result |
| --- | --- |
| `npm test` with `model/work/parity` generated from the FINAL onnx | TBD |

## On-device speed (per phone, from the app's Debug screen: inference ms, backend, fps)

| phone | browser | backend (webgpu / wasm) | inference ms (avg / p95) | processed fps |
| --- | --- | --- | --- | --- |
| TBD | TBD | TBD | TBD | TBD |

## Known failure modes (from looking at the mistakes, not from the totals)

* TBD
