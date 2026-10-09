#!/usr/bin/env python3
"""Export a fine-tuned YOLOv8n checkpoint to the ONNX file the Lubak Alert app loads, and check it against the app's contract.

    # export (needs ultralytics):
    python model/export_onnx.py --weights runs/detect/train/weights/best.pt

    # only check an existing file (needs just onnx + onnxruntime):
    python model/export_onnx.py --verify app/public/models/lubak.onnx

The contract (what app/src/detector.ts assumes), enforced here so a wrong file fails on YOUR machine, not on stage:
    input   float32 [1, 3, 320, 320], RGB 0..1, NCHW
    output  float32 [1, 4 + 3, 2100]   rows 0-3 = cx, cy, w, h in input pixels; rows 4-6 = class scores (sigmoid already applied)
    classes 0 pothole, 1 crack, 2 flooded_road   (this exact order)
    opset   12 by default: widely supported by onnxruntime-web's WebGPU and WASM providers
"""

from __future__ import annotations

import argparse
import hashlib
import shutil
import sys
from pathlib import Path

CLASSES = ["pothole", "crack", "flooded_road"]
STRIDES = (8, 16, 32)  # YOLOv8 detection head strides
DEFAULT_OUT = Path(__file__).resolve().parent.parent / "app" / "public" / "models" / "lubak.onnx"


def anchors_for(imgsz: int) -> int:
    """Number of candidate boxes a YOLOv8 head produces: 1600 + 400 + 100 = 2100 at 320 px."""
    if imgsz % max(STRIDES) != 0:
        raise SystemExit(f"imgsz must be a multiple of {max(STRIDES)}, got {imgsz}")
    return sum((imgsz // s) ** 2 for s in STRIDES)


def verify_onnx(path: Path, imgsz: int = 320) -> dict:
    """Load the file with onnx + onnxruntime and check it matches the app contract. Returns facts; raises SystemExit on a mismatch."""
    import numpy as np
    import onnx
    import onnxruntime as ort

    model = onnx.load(str(path))
    onnx.checker.check_model(model)
    opsets = {o.domain or "ai.onnx": o.version for o in model.opset_import}

    session = ort.InferenceSession(str(path), providers=["CPUExecutionProvider"])
    (inp,) = session.get_inputs()
    want_in = [1, 3, imgsz, imgsz]
    if list(inp.shape) != want_in or inp.type != "tensor(float)":
        raise SystemExit(f"FAIL input: expected float32 {want_in}, found {inp.type} {inp.shape}. Export with --imgsz {imgsz} and dynamic=False.")

    rng = np.random.default_rng(0)
    out = session.run(None, {inp.name: rng.random(want_in, dtype=np.float32)})[0]
    want_out = (1, 4 + len(CLASSES), anchors_for(imgsz))
    if out.shape != want_out:
        found_classes = out.shape[1] - 4 if out.ndim == 3 else "?"
        raise SystemExit(
            f"FAIL output: expected {want_out} ({len(CLASSES)} classes: {', '.join(CLASSES)}), found {out.shape} "
            f"(that is {found_classes} classes). Fine-tune with the class list in model/data.yaml.example."
        )
    if not np.isfinite(out).all():
        raise SystemExit("FAIL output contains NaN or Inf.")
    scores = out[0, 4:, :]
    if scores.min() < -1e-4 or scores.max() > 1 + 1e-4:
        raise SystemExit(f"FAIL class scores are outside 0..1 (min {scores.min():.3f}, max {scores.max():.3f}): the export lacks the sigmoid, so confidence thresholds would be meaningless.")
    boxes = out[0, :4, :]
    if boxes.max() > 2 * imgsz or boxes.min() < -imgsz:
        raise SystemExit(f"FAIL box rows look normalised or wrong (range {boxes.min():.1f}..{boxes.max():.1f}); the app expects pixels in the {imgsz} px input.")

    return {
        "path": str(path),
        "size_mb": round(path.stat().st_size / 1e6, 2),
        "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
        "input": f"{inp.name} {want_in}",
        "output": f"{session.get_outputs()[0].name} {list(out.shape)}",
        "opsets": opsets,
        "onnxruntime": ort.__version__,
    }


def export(weights: Path, imgsz: int, opset: int, out_path: Path) -> Path:
    from ultralytics import YOLO  # imported late so --verify works without it

    model = YOLO(str(weights))
    names = [model.names[i] for i in sorted(model.names)]
    if names != CLASSES:
        raise SystemExit(
            f"FAIL class names/order in {weights}: found {names}, expected {CLASSES}. "
            "Class order is the contract with the app (shared/src/hazard.ts); retrain with model/data.yaml.example."
        )
    exported = Path(
        model.export(format="onnx", imgsz=imgsz, opset=opset, simplify=True, dynamic=False, nms=False, batch=1, device="cpu")
    )
    out_path.parent.mkdir(parents=True, exist_ok=True)
    if exported.resolve() != out_path.resolve():
        shutil.copyfile(exported, out_path)
    return out_path


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--weights", type=Path, help="fine-tuned .pt checkpoint, e.g. runs/detect/train/weights/best.pt")
    p.add_argument("--verify", type=Path, help="only check this existing .onnx against the app contract")
    p.add_argument("--out", type=Path, default=DEFAULT_OUT, help=f"where to write the model (default {DEFAULT_OUT})")
    p.add_argument("--imgsz", type=int, default=320)
    p.add_argument("--opset", type=int, default=12)
    args = p.parse_args()

    if bool(args.weights) == bool(args.verify):
        p.error("give exactly one of --weights (export) or --verify (check only)")

    if args.verify:
        target = args.verify
    else:
        target = export(args.weights, args.imgsz, args.opset, args.out)
        print(f"exported {target}")

    facts = verify_onnx(target, args.imgsz)
    print("OK, the file matches the app contract:")
    for key, value in facts.items():
        print(f"  {key:12} {value}")
    if args.weights:
        print("\nNext: commit it, rebuild the app, and on each phone use Debug > 'Reset app cache & reload' (the old model is precached).")
        print("Record the exact weights, training command, data versions and the metrics YOU measured in model/RESULTS.md.")


if __name__ == "__main__":
    try:
        main()
    except ImportError as err:
        sys.exit(f"missing dependency: {err}. Install with: pip install -r model/requirements.txt")
