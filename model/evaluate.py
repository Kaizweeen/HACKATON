"""Precision / recall per class at several confidence thresholds, from predictions and YOLO label files.

Why this exists: the app's Confirmer needs ONE confidence threshold per class (app/src/confirmer.ts), and `yolo val` reports
precision / recall only at its own best-F1 point. This computes them at the thresholds you are choosing between, on YOUR validation
set, so the numbers that go into the app (and into the pitch) are ones you measured.

Matching rule: a prediction is a true positive if it overlaps a not-yet-matched ground-truth box of the same class with IoU >= 0.5,
highest-confidence predictions first. Everything else is a false positive; unmatched ground truth is a false negative.
Pure numpy + standard library, so it is unit-tested without torch.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Sequence

import numpy as np


@dataclass
class Box:
    cls: int
    x1: float
    y1: float
    x2: float
    y2: float
    conf: float = 1.0


def yolo_line_to_box(line: str, width: int, height: int) -> Box:
    """'cls cx cy w h' (normalised) -> pixel Box."""
    c, cx, cy, w, h = line.split()[:5]
    cx, cy, w, h = float(cx) * width, float(cy) * height, float(w) * width, float(h) * height
    return Box(int(float(c)), cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2)


def iou(a: Box, b: Box) -> float:
    iw = min(a.x2, b.x2) - max(a.x1, b.x1)
    ih = min(a.y2, b.y2) - max(a.y1, b.y1)
    if iw <= 0 or ih <= 0:
        return 0.0
    inter = iw * ih
    union = (a.x2 - a.x1) * (a.y2 - a.y1) + (b.x2 - b.x1) * (b.y2 - b.y1) - inter
    return inter / union if union > 0 else 0.0


def count_matches(preds: Sequence[Box], truth: Sequence[Box], iou_min: float = 0.5) -> tuple[int, int, int]:
    """(true positives, false positives, false negatives) for ONE image and ONE class."""
    matched: set[int] = set()
    tp = 0
    for p in sorted(preds, key=lambda b: -b.conf):
        best, best_iou = -1, iou_min
        for j, t in enumerate(truth):
            if j in matched:
                continue
            value = iou(p, t)
            if value >= best_iou:
                best, best_iou = j, value
        if best >= 0:
            matched.add(best)
            tp += 1
    return tp, len(preds) - tp, len(truth) - tp


def precision_recall(
    images: Sequence[tuple[Sequence[Box], Sequence[Box]]],
    classes: Sequence[str],
    thresholds: Sequence[float],
    iou_min: float = 0.5,
) -> dict[str, list[dict[str, float]]]:
    """images = [(predictions, ground_truth), ...]. Predictions should come from a LOW confidence floor (e.g. conf=0.001)
    so every threshold can be applied here. Returns {class: [{threshold, precision, recall, tp, fp, fn}, ...]}."""
    out: dict[str, list[dict[str, float]]] = {}
    for ci, name in enumerate(classes):
        rows = []
        for t in thresholds:
            tp = fp = fn = 0
            for preds, truth in images:
                a, b, c = count_matches([p for p in preds if p.cls == ci and p.conf >= t], [g for g in truth if g.cls == ci], iou_min)
                tp, fp, fn = tp + a, fp + b, fn + c
            rows.append(
                {
                    "threshold": t,
                    "precision": tp / (tp + fp) if tp + fp else float("nan"),
                    "recall": tp / (tp + fn) if tp + fn else float("nan"),
                    "tp": tp,
                    "fp": fp,
                    "fn": fn,
                }
            )
        out[name] = rows
    return out


def format_table(result: dict[str, list[dict[str, float]]]) -> str:
    lines = []
    for name, rows in result.items():
        lines.append(f"{name}")
        lines.append("  threshold  precision  recall   TP    FP    FN")
        for r in rows:
            lines.append(f"  {r['threshold']:9.3f}  {r['precision']:9.3f}  {r['recall']:6.3f}  {int(r['tp']):4d}  {int(r['fp']):4d}  {int(r['fn']):4d}")
    return "\n".join(lines)


def pick_threshold(rows: list[dict[str, float]], min_precision: float) -> float | None:
    """Lowest threshold whose precision is at least `min_precision` (so recall stays as high as that allows), or None."""
    ok = [r for r in rows if r["precision"] == r["precision"] and r["precision"] >= min_precision]  # NaN-safe
    return min((r["threshold"] for r in ok), default=None)
