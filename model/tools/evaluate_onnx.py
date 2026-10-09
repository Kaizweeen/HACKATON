#!/usr/bin/env python3
"""Measure the exported lubak.onnx itself (the file the app runs), per class, on a dataset split.

    python model/tools/evaluate_onnx.py --split val                      # choose the app's thresholds here
    python model/tools/evaluate_onnx.py --split test --use val           # report on images nothing was tuned on

Same path as the app and as model/tools/parity_ref.py: Ultralytics letterbox to 320 px, onnxruntime, class-aware NMS
(IoU 0.45), boxes back to the original image. Predictions are kept down to confidence 0.001 so every threshold can be applied
afterwards; matching and counting is model/evaluate.py (IoU >= 0.5, one prediction per ground-truth box).

`--split val` picks, per class, the lowest threshold whose precision reaches --min-precision and writes them to
model/work/eval/thresholds.json. `--split test --use val` then reports precision / recall at exactly those thresholds on the test
split, which neither training nor threshold choice has seen. Thresholds below 0.25 are pointless: the app's detector drops
everything under 0.25 before the confirmer (OnnxDetector confThreshold).
Needs: ultralytics, onnxruntime, opencv-python, numpy, torch.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import cv2
import numpy as np
import onnxruntime as ort
import torch
from ultralytics.data.augment import LetterBox
from ultralytics.utils import ops
from ultralytics.utils.nms import non_max_suppression

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
import evaluate as ev  # noqa: E402
from datasets import CLASSES  # noqa: E402

ROOT = HERE.parent.parent
IMGSZ = 320
APP_FLOOR = 0.25  # OnnxDetector confThreshold in app/src/detector.ts
THRESHOLDS = [0.25, 0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8]


def predict(session: ort.InferenceSession, bgr: np.ndarray) -> list[ev.Box]:
    letterboxed = LetterBox((IMGSZ, IMGSZ), auto=False, scaleup=True, center=True, stride=32)(image=bgr)
    tensor = np.ascontiguousarray(letterboxed[..., ::-1].transpose(2, 0, 1)[None], dtype=np.float32) / 255.0
    raw = session.run(None, {session.get_inputs()[0].name: tensor})[0]
    dets = non_max_suppression(torch.from_numpy(raw), conf_thres=0.001, iou_thres=0.45, max_det=100)[0]
    dets[:, :4] = ops.scale_boxes((IMGSZ, IMGSZ), dets[:, :4], bgr.shape)
    return [ev.Box(int(c), float(x1), float(y1), float(x2), float(y2), conf=float(s)) for x1, y1, x2, y2, s, c in dets.tolist()]


def image_level(rows: list, classes: list[str], thresholds: dict[str, float | None]) -> dict[str, dict[str, float]]:
    """What the app cares about more than per-box recall: of the photos that show a class, how many get at least one correct box
    (IoU >= 0.5) at the class threshold; of the photos that do not show it, how many get a box of it anyway (a false alarm)."""
    out: dict[str, dict[str, float]] = {}
    for ci, name in enumerate(classes):
        t = thresholds.get(name)
        if t is None:
            continue
        with_cls = hit = without = false_alarm = 0
        for preds, truth in rows:
            mine = [p for p in preds if p.cls == ci and p.conf >= t]
            gt = [g for g in truth if g.cls == ci]
            if gt:
                with_cls += 1
                tp, _, _ = ev.count_matches(mine, gt)
                hit += 1 if tp > 0 else 0
            else:
                without += 1
                false_alarm += 1 if mine else 0
        out[name] = {
            "threshold": t,
            "images_with_class": with_cls,
            "detected_in": hit,
            "image_recall": hit / with_cls if with_cls else float("nan"),
            "images_without_class": without,
            "false_alarm_images": false_alarm,
            "false_alarm_rate": false_alarm / without if without else float("nan"),
        }
    return out


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--onnx", type=Path, default=ROOT / "app" / "public" / "models" / "lubak.onnx")
    p.add_argument("--data", type=Path, default=HERE.parent / "work" / "dataset")
    p.add_argument("--split", default="val", choices=["train", "val", "test"])
    p.add_argument("--use", choices=["val"], help="report at the thresholds chosen earlier on this split (thresholds.json)")
    p.add_argument("--min-precision", type=float, default=0.7, help="precision a class must reach for its threshold (val only)")
    p.add_argument("--out", type=Path, default=HERE.parent / "work" / "eval")
    args = p.parse_args()

    session = ort.InferenceSession(str(args.onnx), providers=["CPUExecutionProvider"])
    images = sorted(f for f in (args.data / "images" / args.split).iterdir() if f.suffix.lower() in (".jpg", ".jpeg", ".png"))
    rows = []
    for image in images:
        bgr = cv2.imread(str(image))
        h, w = bgr.shape[:2]
        label = args.data / "labels" / args.split / f"{image.stem}.txt"
        truth = [ev.yolo_line_to_box(line, w, h) for line in label.read_text().splitlines() if line.strip()] if label.exists() else []
        rows.append((predict(session, bgr), truth))

    args.out.mkdir(parents=True, exist_ok=True)
    table = ev.precision_recall(rows, CLASSES, THRESHOLDS)
    print(f"{args.onnx.name} on {args.split}: {len(images)} images, IoU >= 0.5\n")
    print(ev.format_table(table))
    result: dict = {"onnx": str(args.onnx), "split": args.split, "images": len(images), "table": table}

    if args.use:
        chosen = json.loads((args.out / "thresholds.json").read_text())["thresholds"]
        at = {}
        for name, value in chosen.items():
            if value is None:
                continue
            row = ev.precision_recall(rows, CLASSES, [value])[name][0]
            at[name] = row
            print(f"\n{name} at the threshold chosen on {args.use} ({value}): precision {row['precision']:.3f}, recall {row['recall']:.3f}  (TP {int(row['tp'])}, FP {int(row['fp'])}, FN {int(row['fn'])})")
        result["at_chosen_thresholds"] = at
        result["image_level"] = image_level(rows, CLASSES, chosen)
        for name, r in result["image_level"].items():
            print(f"{name}: found in {r['detected_in']} of {r['images_with_class']} photos that show one ({r['image_recall']:.1%}); "
                  f"a false {name} box in {r['false_alarm_images']} of {r['images_without_class']} photos without one ({r['false_alarm_rate']:.1%})")
    elif args.split == "val":
        chosen = {name: ev.pick_threshold(rows_, args.min_precision) for name, rows_ in table.items()}
        print(f"\nlowest threshold with precision >= {args.min_precision}: {chosen}  (None: no threshold reaches it, or no data)")
        (args.out / "thresholds.json").write_text(json.dumps({"min_precision": args.min_precision, "thresholds": chosen}, indent=2))
        result["chosen"] = chosen
        result["image_level"] = image_level(rows, CLASSES, chosen)
    (args.out / f"{args.split}.json").write_text(json.dumps(result, indent=2))
    print(f"\nwrote {args.out / f'{args.split}.json'}")


if __name__ == "__main__":
    main()
