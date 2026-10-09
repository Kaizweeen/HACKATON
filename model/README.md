# model: YOLOv8n for potholes, cracks and flooded roads

Everything needed to go from "labelled road photos" to the one file the app loads, **`app/public/models/lubak.onnx`**.
No model is trained or included yet: the repository has the pipeline, the checks and a Colab outline, not weights, and **no accuracy figure exists**
([`RESULTS.md`](RESULTS.md) is where the real ones go, once somebody measures them).

| file | what it is |
| --- | --- |
| [`train_lubak_yolov8n.ipynb`](train_lubak_yolov8n.ipynb) | Colab-ready **outline**: data conversion, flood-image intake, training, honest evaluation, ONNX export, hand-off checklist. Cells marked TODO need your data or a decision |
| [`export_onnx.py`](export_onnx.py) | export a checkpoint at 320 px and **verify** the file against the app's contract; `--verify file.onnx` checks any existing file |
| [`datasets.py`](datasets.py) | RDD2022 (Pascal VOC) to YOLO labels with our three classes, leakage-aware split, fold-in of other YOLO datasets (the flood images) |
| [`evaluate.py`](evaluate.py) | precision / recall per class at the confidence thresholds you are choosing between |
| [`tools/parity_ref.py`](tools/parity_ref.py) | Ultralytics reference outputs so `npm test` can prove the app decodes your model identically |
| [`tools/make_dummy_onnx.py`](tools/make_dummy_onnx.py) | a TEST-ONLY model with the right shapes, so the app's whole inference path can be exercised before training finishes |
| [`RESULTS.md`](RESULTS.md) | template for what you measured. Empty on purpose |
| [`tests/`](tests) | `python -m unittest discover -s model/tests` (standard library only) |

## The contract with the app

| | |
| --- | --- |
| Classes, in this order | `0 pothole`, `1 crack`, `2 flooded_road` (`HAZARD_CLASSES`, `shared/src/hazard.ts`) |
| Input | float32 `[1, 3, 320, 320]`, RGB, 0..1, letterboxed with grey 114 |
| Output | float32 `[1, 7, 2100]`: rows 0-3 are `cx, cy, w, h` in input pixels, rows 4-6 are class scores (sigmoid already applied), 2100 = 40² + 20² + 10² anchors |
| Format | opset 12, fp32, `dynamic=False`, no NMS inside (the app does class-aware NMS itself) |

`export_onnx.py` refuses a checkpoint whose class names or order differ, and refuses an exported file that violates any line above. If you ever change the
input size, change `MODEL_INPUT_SIZE` in `app/src/config.ts` too; the class list lives in `shared/` and `datasets.py`.

## Data

* **Potholes and cracks: RDD2022** (the CRDDC2022 road damage dataset, Pascal VOC boxes). `D40` becomes `pothole`; `D00`, `D10`, `D20` become `crack`.
  It has **no Philippine roads** and **no flooded roads**. Its motorbike-mounted China subset is the closest match to a handlebar-mounted phone.
  Check and respect its licence; cite it.
* **Flooded roads: you have to supply them** (the biggest open item). Public datasets, your own photos and video frames from the real mount, or all of them. Label one box around the
  flooded stretch of road, include wet-but-passable roads, puddles and reflections as negatives, and write the sources and licences into `RESULTS.md`.
* **Local data beats everything**: a few hundred labelled frames from the actual phone mount on Antipolo roads will teach the model more about the demo than thousands of foreign images.
* Split in contiguous blocks, never per frame: neighbouring frames look alike, and a per-frame split makes every metric look better than reality.

## Workflow

1. Open the notebook in Colab (GPU), fill the TODOs, run it. Train, then look at the evaluation cell's per-class precision / recall table.
2. Choose a confidence threshold per class (the notebook shows how) and put them in `DEFAULT_CONFIRMER_CONFIG.thresholds` (`app/src/confirmer.ts`).
3. `python model/export_onnx.py --weights runs/.../best.pt` writes and verifies `app/public/models/lubak.onnx`.
4. Generate the parity reference with `parity_ref.py` on a few of your validation photos, put it in `model/work/parity/`, run `npm test`.
   On the final model this is what proves the app reads your model the way Ultralytics does.
5. Commit the ONNX (about 12 MB), `npm run build`, test on real phones, record the Debug screen's inference ms and backend per phone in `RESULTS.md`.

## What has and has not been verified

Verified with a real (toy-trained, so meaningless in accuracy) 3-class YOLOv8n exported by this script (Ultralytics 8.4.174, onnxruntime 1.31):
the export produces input `[1,3,320,320]` and output `[1,7,2100]` at opset 12; the app's TypeScript decode, class-aware NMS and
un-letterbox return the same detections as Ultralytics' own `non_max_suppression` + `scale_boxes` (box differences below 0.005 px); onnxruntime-web on WASM and on WebGPU
matches Python's onnxruntime to about 1e-6 on that graph; the browser's canvas preprocessing differs from OpenCV's letterbox by about a quarter of an 8-bit level on average
(worst single value: one level on four of five test images, about ten on an odd-sized 641x361 one). Whether that matters for a trained model's accuracy has not been measured.

**Not** verified: how accurate any trained model is (none exists), WebGPU on real phone GPUs, inference time on phones (the Debug screen reports it), iOS Safari.
For scale only: a single-threaded WASM run of the real YOLOv8n graph measured about 100 to 200 ms per frame including preprocessing on the Xeon server CPU of the
build container, which is not a phone and not a benchmark.

## Notes

* Fewer or more classes later? Change `HAZARD_CLASSES` (`shared/src/hazard.ts`), `CLASSES` in `datasets.py` / `export_onnx.py`, the thresholds in `confirmer.ts`, and the palette in `app/src/classes.ts`. The app's output-shape check will tell you if one was missed.
* INT8 or fp16 can shrink and speed up the model, but test them on the phones: WebGPU and WASM support differs by operator and device.
* Keep `model/work/`, `model/runs/`, `*.pt` and datasets out of git (already in `.gitignore`).
