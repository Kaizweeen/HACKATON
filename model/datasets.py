"""Dataset helpers for Lubak Alert: RDD2022 (Pascal VOC) -> YOLO labels with OUR three classes, plus a leakage-aware split.

Pure standard library on purpose: runs in Colab, locally and in tests without torch.

Classes (index = what the app expects, see shared/src/hazard.ts HAZARD_CLASSES):
    0 pothole    1 crack    2 flooded_road

RDD2022 damage codes:  D00 longitudinal crack, D10 transverse crack, D20 alligator crack  -> crack
                       D40 pothole                                                         -> pothole
Everything else in the XML (other codes) is ignored.
RDD2022 has NO flooded-road class: those images come from somewhere else (see model/README.md).
"""

from __future__ import annotations

import os
import random
import shutil
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable, Sequence

CLASSES: list[str] = ["pothole", "crack", "flooded_road"]
RDD_TO_LUBAK: dict[str, str] = {"D00": "crack", "D10": "crack", "D20": "crack", "D40": "pothole"}
IMAGE_SUFFIXES = (".jpg", ".jpeg", ".png")


@dataclass
class VocBox:
    name: str
    xmin: float
    ymin: float
    xmax: float
    ymax: float


@dataclass
class VocAnnotation:
    width: int
    height: int
    boxes: list[VocBox] = field(default_factory=list)


def parse_voc(xml_path: str | Path) -> VocAnnotation:
    """Read one Pascal VOC annotation file."""
    root = ET.parse(xml_path).getroot()
    size = root.find("size")
    if size is None:
        raise ValueError(f"{xml_path}: no <size> element")
    width = int(float(size.findtext("width", "0")))
    height = int(float(size.findtext("height", "0")))
    if width <= 0 or height <= 0:
        raise ValueError(f"{xml_path}: bad image size {width}x{height}")
    ann = VocAnnotation(width, height)
    for obj in root.iter("object"):
        bb = obj.find("bndbox")
        if bb is None:
            continue
        ann.boxes.append(
            VocBox(
                name=(obj.findtext("name") or "").strip(),
                xmin=float(bb.findtext("xmin", "0")),
                ymin=float(bb.findtext("ymin", "0")),
                xmax=float(bb.findtext("xmax", "0")),
                ymax=float(bb.findtext("ymax", "0")),
            )
        )
    return ann


def voc_to_yolo_lines(
    xml_path: str | Path,
    mapping: dict[str, str] = RDD_TO_LUBAK,
    classes: Sequence[str] = CLASSES,
    min_box_px: float = 4.0,
) -> list[str]:
    """YOLO label lines ("class cx cy w h", all normalised) for one VOC file. Unmapped codes and tiny boxes are dropped."""
    ann = parse_voc(xml_path)
    lines: list[str] = []
    for b in ann.boxes:
        target = mapping.get(b.name)
        if target is None:
            continue
        x1, x2 = sorted((max(0.0, min(b.xmin, ann.width)), max(0.0, min(b.xmax, ann.width))))
        y1, y2 = sorted((max(0.0, min(b.ymin, ann.height)), max(0.0, min(b.ymax, ann.height))))
        if (x2 - x1) < min_box_px or (y2 - y1) < min_box_px:
            continue
        cx, cy = (x1 + x2) / 2 / ann.width, (y1 + y2) / 2 / ann.height
        w, h = (x2 - x1) / ann.width, (y2 - y1) / ann.height
        lines.append(f"{classes.index(target)} {cx:.6f} {cy:.6f} {w:.6f} {h:.6f}")
    return lines


def find_voc_pairs(root: str | Path) -> list[tuple[Path, Path]]:
    """(image, xml) pairs under an RDD2022 folder. Looks for .../annotations/xmls/X.xml next to .../images/X.jpg."""
    root = Path(root)
    pairs: list[tuple[Path, Path]] = []
    for xml in sorted(root.rglob("*.xml")):
        images_dir = xml.parent.parent.parent / "images"  # <split>/annotations/xmls/x.xml -> <split>/images
        for suffix in IMAGE_SUFFIXES:
            candidate = images_dir / f"{xml.stem}{suffix}"
            if candidate.exists():
                pairs.append((candidate, xml))
                break
    return pairs


def split_by_blocks(stems: Sequence[str], val_fraction: float = 0.15, block: int = 40, seed: int = 0) -> tuple[list[str], list[str]]:
    """Train/val split in CONTIGUOUS BLOCKS of the sorted names instead of per image.

    RDD2022 frames from the same road are numbered consecutively and look alike. A random per-image split puts near-duplicates
    on both sides and inflates validation metrics. Whole blocks go to one side, which removes most of that leakage.
    It is a heuristic: for a trustworthy number, also hold out a different place or recording entirely.
    """
    ordered = sorted(stems)
    blocks = [ordered[i : i + block] for i in range(0, len(ordered), block)]
    rng = random.Random(seed)
    order = list(range(len(blocks)))
    rng.shuffle(order)
    target = round(len(ordered) * val_fraction)
    val_blocks: set[int] = set()
    count = 0
    for idx in order:
        if count >= target:
            break
        val_blocks.add(idx)
        count += len(blocks[idx])
    train = [s for i, b in enumerate(blocks) if i not in val_blocks for s in b]
    val = [s for i, b in enumerate(blocks) if i in val_blocks for s in b]
    return train, val


def _place(src: Path, dst: Path, link: bool) -> None:
    dst.parent.mkdir(parents=True, exist_ok=True)
    if dst.exists() or dst.is_symlink():
        dst.unlink()
    if link:
        os.symlink(src.resolve(), dst)
    else:
        shutil.copy2(src, dst)


def write_sample(image: Path, label_lines: Iterable[str], dest_root: Path, split: str, name: str, link: bool = False) -> None:
    """Add one image + label to dest_root/{images,labels}/{split}/ using Ultralytics' folder convention."""
    _place(image, dest_root / "images" / split / f"{name}{image.suffix.lower()}", link)
    label_path = dest_root / "labels" / split / f"{name}.txt"
    label_path.parent.mkdir(parents=True, exist_ok=True)
    label_path.write_text("\n".join(label_lines) + ("\n" if label_lines else ""))


def convert_rdd2022(
    src_root: str | Path,
    dest_root: str | Path,
    val_fraction: float = 0.15,
    keep_negatives: bool = True,
    link: bool = False,
    prefix: str = "rdd",
) -> dict[str, int]:
    """Convert every annotated RDD2022 image under src_root into dest_root, split in blocks per country folder.

    Returns counts. Images whose boxes all map to ignored codes become negatives (empty label file) when keep_negatives.
    """
    src_root, dest_root = Path(src_root), Path(dest_root)
    by_group: dict[str, list[tuple[Path, Path]]] = {}
    for image, xml in find_voc_pairs(src_root):
        group = image.relative_to(src_root).parts[0] if len(image.relative_to(src_root).parts) > 1 else "all"
        by_group.setdefault(group, []).append((image, xml))

    counts = {"train": 0, "val": 0, "boxes_pothole": 0, "boxes_crack": 0, "negatives": 0, "skipped_bad_xml": 0}
    for group, pairs in sorted(by_group.items()):
        index = {image.stem: (image, xml) for image, xml in pairs}
        train, val = split_by_blocks(list(index), val_fraction)
        for split, stems in (("train", train), ("val", val)):
            for stem in stems:
                image, xml = index[stem]
                try:
                    lines = voc_to_yolo_lines(xml)
                except (ET.ParseError, ValueError):
                    counts["skipped_bad_xml"] += 1
                    continue
                if not lines and not keep_negatives:
                    continue
                if not lines:
                    counts["negatives"] += 1
                write_sample(image, lines, dest_root, split, f"{prefix}_{group}_{stem}", link)
                counts[split] += 1
                for line in lines:
                    counts["boxes_pothole" if line.startswith("0 ") else "boxes_crack"] += 1
    return counts


def add_yolo_folder(
    src_root: str | Path,
    dest_root: str | Path,
    class_map: dict[int, int],
    prefix: str,
    val_fraction: float = 0.15,
    link: bool = False,
    block: int = 40,
) -> dict[str, int]:
    """Fold an existing YOLO-format dataset (images/ + labels/ side by side, any split names) into dest_root with OUR class ids.

    Use it for the flood images: label them in any tool, export YOLO format, then
        add_yolo_folder("flood_raw", dest, class_map={0: 2}, prefix="flood")      # their class 0 -> our flooded_road (2)
    class_map maps THEIR class index to ours; boxes of classes not in the map are dropped. Images are split in contiguous blocks
    (see split_by_blocks), because frames from one video look alike. Returns counts.
    """
    src_root, dest_root = Path(src_root), Path(dest_root)
    images = sorted(p for p in src_root.rglob("*") if p.suffix.lower() in IMAGE_SUFFIXES and "labels" not in p.parts)
    by_stem: dict[str, tuple[Path, Path]] = {}
    for image in images:
        # Ultralytics' own convention: .../images/<split>/x.jpg -> .../labels/<split>/x.txt; else a label file next to the image
        swapped = Path(str(image).replace(f"{os.sep}images{os.sep}", f"{os.sep}labels{os.sep}")).with_suffix(".txt")
        candidates = [swapped, image.with_suffix(".txt")]
        label = next((c for c in candidates if c.exists()), None)
        if label is not None:
            by_stem[f"{image.parent.name}_{image.stem}"] = (image, label)

    counts = {"train": 0, "val": 0, "boxes": 0, "dropped_boxes": 0, "images_without_label": len(images) - len(by_stem)}
    train, val = split_by_blocks(list(by_stem), val_fraction, block=block)
    for split, stems in (("train", train), ("val", val)):
        for stem in stems:
            image, label = by_stem[stem]
            lines: list[str] = []
            for raw in label.read_text().splitlines():
                parts = raw.split()
                if len(parts) < 5:
                    continue
                theirs = int(float(parts[0]))
                if theirs not in class_map:
                    counts["dropped_boxes"] += 1
                    continue
                lines.append(" ".join([str(class_map[theirs]), *parts[1:5]]))
            write_sample(image, lines, dest_root, split, f"{prefix}_{stem}", link)
            counts[split] += 1
            counts["boxes"] += len(lines)
    return counts


def write_data_yaml(dest_root: str | Path, classes: Sequence[str] = CLASSES) -> Path:
    """data.yaml for Ultralytics. Class ORDER is the contract with the app: do not reorder."""
    dest_root = Path(dest_root).resolve()
    lines = [f"path: {dest_root}", "train: images/train", "val: images/val", f"nc: {len(classes)}", "names:"]
    lines += [f"  {i}: {name}" for i, name in enumerate(classes)]
    path = dest_root / "data.yaml"
    path.write_text("\n".join(lines) + "\n")
    return path


def class_histogram(dest_root: str | Path, classes: Sequence[str] = CLASSES) -> dict[str, dict[str, int]]:
    """Box counts per class and split, from the label files. Read this before training: a class with a few dozen boxes will not learn."""
    dest_root = Path(dest_root)
    out: dict[str, dict[str, int]] = {}
    for split in ("train", "val"):
        counts = {name: 0 for name in classes}
        images = len(list((dest_root / "images" / split).glob("*"))) if (dest_root / "images" / split).exists() else 0
        for label in (dest_root / "labels" / split).glob("*.txt") if (dest_root / "labels" / split).exists() else []:
            for line in label.read_text().splitlines():
                if line.strip():
                    counts[classes[int(line.split()[0])]] += 1
        out[split] = {"images": images, **counts}
    return out


def check_no_leakage(dest_root: str | Path) -> list[str]:
    """Names present in both train and val (should be empty)."""
    dest_root = Path(dest_root)
    names = {s: {p.stem for p in (dest_root / "images" / s).glob("*")} for s in ("train", "val")}
    return sorted(names["train"] & names["val"])
