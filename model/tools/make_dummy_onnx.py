#!/usr/bin/env python3
"""Generate a TEST-ONLY ONNX model with the same input/output shapes as the real YOLOv8n export, so the app's whole
inference path (preprocessing, onnxruntime-web on WebGPU/WASM, decoding, confirmation, sync, map) can be exercised
before any training has finished.

    python model/tools/make_dummy_onnx.py            # writes app/public/models/dummy-pipeline-test.onnx
    # then open the app with:  /?detector=onnx&model=/models/dummy-pipeline-test.onnx

What it does: finds the "bright" blob in the image (any channel above 0.5), and reports ONE detection at anchor 0:
    box   = centroid of the blob, size = sqrt(area) (so it is exact for a filled square), in model-input pixels
    class = the blob's colour: red -> pothole (0), green -> crack (1), blue -> flooded_road (2); score = 0.9 x that channel's mean
Every other anchor is zero. Grey letterbox padding (114/255 = 0.447) stays below the 0.5 threshold and is ignored.
Because the output depends on the pixels, it proves channel order (RGB), planar CHW layout, 0..1 scaling and the
letterbox maths end to end. It detects NOTHING real. It will never be written under the real model's name.
"""

from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np
import onnx
from onnx import TensorProto, helper, numpy_helper

SIZE = 320
CLASSES = 3
ANCHORS = 2100  # 40*40 + 20*20 + 10*10
DEFAULT_OUT = Path(__file__).resolve().parents[2] / "app" / "public" / "models" / "dummy-pipeline-test.onnx"


def build(size: int = SIZE, anchors: int = ANCHORS) -> onnx.ModelProto:
    init = []
    nodes = []

    def const(name, value, dtype=np.float32):
        init.append(numpy_helper.from_array(np.asarray(value, dtype=dtype), name))
        return name

    def node(op, inputs, output, **attrs):
        nodes.append(helper.make_node(op, inputs, [output], **attrs))
        return output

    half = const("half", 0.5)
    eps = const("eps", 1e-6)
    one = const("one", 1.0)
    conf = const("conf", 0.9)
    arange = const("arange", np.arange(size, dtype=np.float32) + 0.5)  # pixel centres
    axes_y = const("axes_y", [2], np.int64)
    axes_x = const("axes_x", [3], np.int64)
    unsq = const("unsq", [0, 1, 2], np.int64)
    zeros_shape = const("zeros_shape", [1, 4 + CLASSES, anchors - 1], np.int64)

    # mask = (max over channels > 0.5)  -> [1,1,H,W] float
    mx = node("ReduceMax", ["images"], "mx", axes=[1], keepdims=1)  # opset 13: axes is an attribute here (but an input for ReduceSum)
    gt = node("Greater", [mx, half], "gt")
    mask = node("Cast", [gt], "mask", to=TensorProto.FLOAT)

    total = node("ReduceSum", [mask], "total", keepdims=0)
    col = node("ReduceSum", [mask, axes_y], "col", keepdims=0)  # [1,1,W]: bright pixels per column
    row = node("ReduceSum", [mask, axes_x], "row", keepdims=0)  # [1,1,H]: bright pixels per row
    denom = node("Add", [total, eps], "denom")
    cx = node("Div", [node("ReduceSum", [node("Mul", [col, arange], "col_w")], "sx", keepdims=0), denom], "cx")
    cy = node("Div", [node("ReduceSum", [node("Mul", [row, arange], "row_w")], "sy", keepdims=0), denom], "cy")
    side = node("Sqrt", [total], "side")
    present = node("Min", [total, one], "present")

    scores = []
    for c in range(CLASSES):
        idx = const(f"idx{c}", [c], np.int64)
        ch = node("Gather", ["images", idx], f"ch{c}", axis=1)  # [1,1,H,W]
        inside = node("ReduceSum", [node("Mul", [ch, mask], f"chm{c}")], f"inside{c}", keepdims=0)
        mean = node("Div", [inside, denom], f"mean{c}")
        scores.append(node("Mul", [node("Mul", [mean, conf], f"s{c}a"), present], f"score{c}"))

    parts = [cx, cy, side, side, *scores]
    shaped = [node("Unsqueeze", [p, unsq], f"part{i}_111") for i, p in enumerate(parts)]  # each [1,1,1]; indexed because w and h share one input
    det = node("Concat", shaped, "det", axis=1)  # [1,7,1]
    zeros = node("ConstantOfShape", [zeros_shape], "zeros", value=numpy_helper.from_array(np.zeros(1, dtype=np.float32), "z"))
    node("Concat", [det, zeros], "output0", axis=2)  # [1,7,anchors]

    graph = helper.make_graph(
        nodes,
        "lubak_dummy_pipeline_test",
        [helper.make_tensor_value_info("images", TensorProto.FLOAT, [1, 3, size, size])],
        [helper.make_tensor_value_info("output0", TensorProto.FLOAT, [1, 4 + CLASSES, anchors])],
        initializer=init,
    )
    model = helper.make_model(graph, opset_imports=[helper.make_opsetid("", 13)], producer_name="lubak-dummy")
    model.ir_version = 8  # old enough for every onnxruntime build
    model.doc_string = "TEST FIXTURE. Not a detector. See model/tools/make_dummy_onnx.py."
    onnx.checker.check_model(model)
    return model


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--out", type=Path, default=DEFAULT_OUT)
    args = p.parse_args()
    if args.out.name == "lubak.onnx":
        raise SystemExit("refusing to write a test model under the real model's name (lubak.onnx): the app would present it as real inference")
    args.out.parent.mkdir(parents=True, exist_ok=True)
    onnx.save(build(), args.out)
    print(f"wrote {args.out} ({args.out.stat().st_size / 1024:.1f} KB). TEST ONLY: delete it before a demo.")
    print("open the app with  /?detector=onnx&model=/models/" + args.out.name)


if __name__ == "__main__":
    main()
