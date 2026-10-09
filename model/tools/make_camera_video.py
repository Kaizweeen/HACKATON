#!/usr/bin/env python3
"""Turn road photos into a .y4m video that Chromium can use as a FAKE CAMERA, for rehearsing the whole app without a phone.

    python model/tools/make_camera_video.py                       # held-out pothole test photos -> model/work/camera/road.y4m
    python model/tools/make_camera_video.py --images my_photos/ --seconds 3
    chromium --use-fake-device-for-media-stream --use-file-for-fake-video-capture=model/work/camera/road.y4m ...
    npm run rehearse                                              # does all of that for you (scripts/rehearse.ts)

Each photo is shown for --seconds, letterboxed on grey like a camera filming a print, with a second of plain grey in between so
consecutive photos do not look like one long hazard. Chromium loops the file. Default input: the pothole photos of the dataset's
TEST split (model/tools/build_public_dataset.py), which the model never saw in training, so what the app detects in a rehearsal is
an honest (if small) sample. Needs Pillow and numpy.
"""

from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np
from PIL import Image

HERE = Path(__file__).resolve().parent
DEFAULT_IMAGES = HERE.parent / "work" / "dataset" / "images" / "test"
DEFAULT_OUT = HERE.parent / "work" / "camera" / "road.y4m"


def to_i420(rgb: np.ndarray) -> bytes:
    """RGB uint8 HxWx3 -> planar YUV 4:2:0 (BT.601 full range, what C420jpeg means)."""
    r, g, b = (rgb[..., i].astype(np.float32) for i in range(3))
    y = 0.299 * r + 0.587 * g + 0.114 * b
    u = -0.168736 * r - 0.331264 * g + 0.5 * b + 128
    v = 0.5 * r - 0.418688 * g - 0.081312 * b + 128
    sub = lambda p: p.reshape(p.shape[0] // 2, 2, p.shape[1] // 2, 2).mean(axis=(1, 3))  # noqa: E731
    planes = [y, sub(u), sub(v)]
    return b"".join(np.clip(np.rint(p), 0, 255).astype(np.uint8).tobytes() for p in planes)


def letterbox(path: Path, width: int, height: int) -> np.ndarray:
    img = Image.open(path).convert("RGB")
    scale = min(width / img.width, height / img.height)
    img = img.resize((max(2, round(img.width * scale)), max(2, round(img.height * scale))), Image.Resampling.LANCZOS)
    canvas = Image.new("RGB", (width, height), (114, 114, 114))
    canvas.paste(img, ((width - img.width) // 2, (height - img.height) // 2))
    return np.asarray(canvas)


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--images", type=Path, default=DEFAULT_IMAGES)
    p.add_argument("--pattern", default="pothole_*", help="glob inside --images (default: the pothole photos)")
    p.add_argument("--count", type=int, default=12, help="how many photos (sorted by name, evenly spaced)")
    p.add_argument("--seconds", type=float, default=2.0, help="how long each photo is on screen")
    p.add_argument("--fps", type=int, default=5)
    p.add_argument("--size", default="640x480")
    p.add_argument("--out", type=Path, default=DEFAULT_OUT)
    args = p.parse_args()

    width, height = (int(v) for v in args.size.split("x"))
    if width % 2 or height % 2:
        raise SystemExit("--size must be even in both directions (4:2:0 chroma)")
    photos = sorted(f for f in args.images.glob(args.pattern) if f.suffix.lower() in (".jpg", ".jpeg", ".png"))
    if not photos:
        raise SystemExit(f"no photos matching {args.pattern} in {args.images}; build the dataset first (model/tools/build_public_dataset.py)")
    if len(photos) > args.count:
        step = len(photos) / args.count
        photos = [photos[int(i * step)] for i in range(args.count)]

    grey = to_i420(np.full((height, width, 3), 114, np.uint8))
    args.out.parent.mkdir(parents=True, exist_ok=True)
    frames = 0
    with open(args.out, "wb") as out:
        out.write(f"YUV4MPEG2 W{width} H{height} F{args.fps}:1 Ip A1:1 C420jpeg\n".encode())
        for photo in photos:
            frame = to_i420(letterbox(photo, width, height))
            for _ in range(round(args.seconds * args.fps)):
                out.write(b"FRAME\n" + frame)
                frames += 1
            for _ in range(args.fps):  # one second of nothing between photos
                out.write(b"FRAME\n" + grey)
                frames += 1
    (args.out.with_suffix(".txt")).write_text("\n".join(f.name for f in photos) + "\n")
    print(f"wrote {args.out}: {len(photos)} photos, {frames} frames at {args.fps} fps ({frames / args.fps:.0f} s loop), {args.out.stat().st_size / 1e6:.0f} MB")


if __name__ == "__main__":
    main()
