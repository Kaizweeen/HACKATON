#!/usr/bin/env python3
"""Reference outputs from Ultralytics for an exported lubak.onnx, so the app's TypeScript decoding can be checked against the real thing.

    python model/tools/parity_ref.py --onnx app/public/models/lubak.onnx                  # synthetic test images
    python model/tools/parity_ref.py --onnx app/public/models/lubak.onnx --images my_val/  # your own road photos (recommended)
    npm test                                                                              # app/test/parity.test.ts now runs against model/work/parity/

For each image it letterboxes with Ultralytics' own code, runs the ONNX in onnxruntime, applies Ultralytics' non_max_suppression and
scale_boxes, and stores the raw output tensor next to the reference detections. The app test feeds the SAME raw tensor through
app/src/detector.ts (decode, class-aware NMS, un-letterbox) and requires identical detections. A mismatch means the app would read
your model differently from how you validated it. Needs: pip install ultralytics onnxruntime opencv-python numpy
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import cv2
import numpy as np
import onnxruntime as ort
import torch
from ultralytics.data.augment import LetterBox
from ultralytics.utils import ops
from ultralytics.utils.nms import non_max_suppression

IMGSZ = 320
HERE = Path(__file__).resolve().parent
DEFAULT_OUT = HERE.parent / "work" / "parity"


def synthetic(w: int, h: int, seed: int) -> np.ndarray:
    """RGB test picture with texture and three coloured rectangles. Only used when no --images folder is given."""
    r = np.random.default_rng(seed)
    yy, xx = np.mgrid[0:h, 0:w]
    base = np.stack([(xx / w * 120 + 60), (yy / h * 100 + 70), ((xx + yy) / (w + h) * 90 + 80)], -1)
    img = (base + r.normal(0, 12, base.shape)).clip(0, 255).astype(np.uint8)
    for color in ((230, 40, 40), (40, 200, 60), (50, 90, 235)):
        for _ in range(2):
            bw, bh = int(r.integers(w // 10, w // 4)), int(r.integers(h // 14, h // 5))
            x, y = int(r.integers(0, w - bw)), int(r.integers(0, h - bh))
            img[y : y + bh, x : x + bw] = color
    return img


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--onnx", type=Path, required=True)
    p.add_argument("--images", type=Path, help="folder of .jpg/.png photos; default: five synthetic frames of different shapes")
    p.add_argument("--out", type=Path, default=DEFAULT_OUT)
    p.add_argument("--conf", type=float, default=0.001, help="confidence threshold for the reference NMS (low = more detections to compare)")
    p.add_argument("--iou", type=float, default=0.45)
    p.add_argument("--max-det", type=int, default=300)
    args = p.parse_args()

    args.out.mkdir(parents=True, exist_ok=True)
    session = ort.InferenceSession(str(args.onnx), providers=["CPUExecutionProvider"])
    input_name = session.get_inputs()[0].name

    sources: list[tuple[str, np.ndarray]] = []  # (name, BGR image)
    if args.images:
        for path in sorted(args.images.iterdir()):
            if path.suffix.lower() in (".jpg", ".jpeg", ".png"):
                img = cv2.imread(str(path))
                if img is not None:
                    sources.append((path.stem, img))
    else:
        for i, (name, w, h) in enumerate([("portrait_810x1080", 810, 1080), ("landscape_640x360", 640, 360), ("hd_1280x720", 1280, 720), ("square_320", 320, 320), ("odd_641x361", 641, 361)]):
            sources.append((name, cv2.cvtColor(synthetic(w, h, 10 + i), cv2.COLOR_RGB2BGR)))
    if not sources:
        raise SystemExit("no images found")

    cases = []
    for name, bgr in sources:
        h, w = bgr.shape[:2]
        cv2.imwrite(str(args.out / f"{name}.png"), bgr)  # lossless copy, for browser-side preprocessing comparisons
        letterboxed = LetterBox((IMGSZ, IMGSZ), auto=False, scaleup=True, center=True, stride=32)(image=bgr)
        tensor = np.ascontiguousarray(letterboxed[..., ::-1].transpose(2, 0, 1)[None], dtype=np.float32) / 255.0
        raw = session.run(None, {input_name: tensor})[0]
        tensor.tofile(args.out / f"{name}.input.f32")
        raw.tofile(args.out / f"{name}.raw.f32")
        dets = non_max_suppression(torch.from_numpy(raw), conf_thres=args.conf, iou_thres=args.iou, max_det=args.max_det)[0]
        dets[:, :4] = ops.scale_boxes((IMGSZ, IMGSZ), dets[:, :4], bgr.shape)
        cases.append({"name": name, "w": w, "h": h, "dims": list(raw.shape), "ref": [[round(float(v), 6) for v in row] for row in dets.tolist()]})
        print(f"{name:24} {w}x{h:<5} reference detections: {len(cases[-1]['ref'])}")

    (args.out / "reference.json").write_text(json.dumps({"conf": args.conf, "iou": args.iou, "max_det": args.max_det, "imgsz": IMGSZ, "onnx": str(args.onnx), "cases": cases}))
    print(f"wrote {args.out / 'reference.json'}; now run: npm test")


if __name__ == "__main__":
    main()
