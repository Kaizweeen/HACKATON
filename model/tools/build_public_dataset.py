#!/usr/bin/env python3
"""Download the two PUBLIC datasets the first Lubak Alert model was trained on and assemble them into one YOLO dataset.

    python model/tools/build_public_dataset.py                  # -> model/work/dataset/{images,labels}/{train,val,test} + data.yaml
    python model/tools/build_public_dataset.py --crack-train 0  # potholes only

Sources (both keep their published train / val / test split, so the test images stay unseen until the final measurement):

    pothole  Atikur Rahman Chitholian's pothole dataset, 665 road photos, Roboflow export "pothole-voxrl" v1.
             Licence: ODbL v1.0 (attribution + share-alike for the database). Mirror used: gitlab.com/ykristian/potholedataset,
             pinned to commit 54a2c06b. Upstream: github.com/chitholian/Potholes-Detection, universe.roboflow.com/brad-dwyer/pothole-voxrl
    crack    Ultralytics crack-seg (3717 / 200 / 112 images, polygon masks; polygons become boxes). Release asset of
             github.com/ultralytics/assets, sha256 pinned below. Licence: Public Domain Mark 1.0 according to Ultralytics' dataset
             page (docs.ultralytics.com/datasets/segment/crack-seg); originally Roboflow Universe university-bswxt/crack-bphdr.
             Mostly close-ups of cracked concrete and walls, NOT a camera looking down the road: it teaches what a crack looks
             like, not how one looks from a handlebar mount.

What this dataset does NOT have: flooded roads (class 2 gets zero examples, so the model never reports one), Philippine roads,
and frames from the actual phone mount. Read model/RESULTS.md before quoting any number trained on it.
Standard library only (plus model/datasets.py), so it runs anywhere Python does.
"""

from __future__ import annotations

import argparse
import hashlib
import shutil
import sys
import urllib.request
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
import datasets as ds  # noqa: E402

WORK = HERE.parent / "work"
POTHOLE_COMMIT = "54a2c06b8badec39232755cf9d477436c49216a2"
POTHOLE_URL = "https://gitlab.com/api/v4/projects/ykristian%2Fpotholedataset/repository/archive.zip?sha={commit}&path={split}"
POTHOLE_SPLITS = {"train": 465, "valid": 133, "test": 67}  # images per split in that commit
CRACK_URL = "https://github.com/ultralytics/assets/releases/download/v0.0.0/crack-seg.zip"
CRACK_SHA256 = "814b566d61e890024d15f22a3e6b14e252f781ab83f60a8d59e6684817efecdc"


def download(url: str, dest: Path) -> Path:
    if dest.exists() and dest.stat().st_size > 0:
        return dest
    dest.parent.mkdir(parents=True, exist_ok=True)
    print(f"downloading {url}")
    tmp = dest.with_suffix(dest.suffix + ".part")
    with urllib.request.urlopen(url, timeout=120) as response, open(tmp, "wb") as out:
        shutil.copyfileobj(response, out)
    tmp.rename(dest)
    return dest


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def fetch_pothole(downloads: Path) -> Path:
    root = downloads / "pothole"
    for split, expected in POTHOLE_SPLITS.items():
        archive = download(POTHOLE_URL.format(commit=POTHOLE_COMMIT, split=split), downloads / f"pothole-{split}.zip")
        with zipfile.ZipFile(archive) as z:
            for member in z.namelist():
                # GitLab archives wrap everything in "<repo>-<ref>-<path>/"; keep what follows it
                inner = member.split("/", 1)[1] if "/" in member else ""
                if not inner or member.endswith("/"):
                    continue
                target = root / inner
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(z.read(member))
        found = len(list((root / split / "images").glob("*")))
        if found != expected:
            raise SystemExit(f"pothole/{split}: expected {expected} images at commit {POTHOLE_COMMIT[:8]}, found {found}")
    return root


def fetch_crack(downloads: Path) -> Path:
    archive = download(CRACK_URL, downloads / "crack-seg.zip")
    digest = sha256(archive)
    if digest != CRACK_SHA256:
        raise SystemExit(f"crack-seg.zip sha256 {digest} != pinned {CRACK_SHA256}: the release asset changed; check it, then update the pin")
    root = downloads / "crack"
    if not (root / "images" / "train").is_dir():
        with zipfile.ZipFile(archive) as z:
            z.extractall(root)
    return root


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--out", type=Path, default=WORK / "dataset")
    p.add_argument("--downloads", type=Path, default=WORK / "downloads")
    p.add_argument("--crack-train", type=int, default=1200, help="crack training images to sample (of 3717); 0 = no crack data")
    p.add_argument("--seed", type=int, default=0)
    args = p.parse_args()

    if args.out.exists():
        shutil.rmtree(args.out)
    pothole = ds.add_yolo_splits(fetch_pothole(args.downloads), args.out, {0: 0}, prefix="pothole")
    print("pothole:", pothole)
    if args.crack_train > 0:
        crack = ds.add_yolo_splits(fetch_crack(args.downloads), args.out, {0: 1}, prefix="crack", limits={"train": args.crack_train}, seed=args.seed)
        print("crack:  ", crack)
    leaks = ds.check_no_leakage(args.out)
    if leaks:
        raise SystemExit(f"the same image name is in two splits: {leaks[:5]}")
    yaml_path = ds.write_data_yaml(args.out)
    print(f"wrote {yaml_path}")
    for split, row in ds.class_histogram(args.out).items():
        print(f"  {split:5} " + "  ".join(f"{k} {v}" for k, v in row.items()))


if __name__ == "__main__":
    main()
