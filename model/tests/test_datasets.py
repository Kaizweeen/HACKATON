"""Run with:  python -m unittest discover -s model/tests -v   (standard library only; no torch needed)."""

import sys
import tempfile
import unittest
import xml.etree.ElementTree as ET
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import datasets as ds  # noqa: E402


def voc_xml(width, height, boxes):
    objects = "".join(
        f"<object><name>{n}</name><bndbox><xmin>{a}</xmin><ymin>{b}</ymin><xmax>{c}</xmax><ymax>{d}</ymax></bndbox></object>"
        for n, a, b, c, d in boxes
    )
    return f"<annotation><size><width>{width}</width><height>{height}</height><depth>3</depth></size>{objects}</annotation>"


def write(path: Path, text: str = "") -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)
    return path


class VocToYolo(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())

    def lines(self, width, height, boxes, **kw):
        return ds.voc_to_yolo_lines(write(self.tmp / "a.xml", voc_xml(width, height, boxes)), **kw)

    def test_normalisation_matches_a_hand_computed_example(self):
        # 600x400 image, pothole (D40) from (100,50) to (300,250): centre (200,150), size 200x200
        self.assertEqual(self.lines(600, 400, [("D40", 100, 50, 300, 250)]), ["0 0.333333 0.375000 0.333333 0.500000"])

    def test_all_crack_codes_map_to_crack_and_pothole_to_pothole(self):
        lines = self.lines(100, 100, [("D00", 0, 0, 20, 20), ("D10", 0, 0, 20, 20), ("D20", 0, 0, 20, 20), ("D40", 0, 0, 20, 20)])
        self.assertEqual([l.split()[0] for l in lines], ["1", "1", "1", "0"])

    def test_ignores_codes_we_do_not_detect(self):
        self.assertEqual(self.lines(100, 100, [("D43", 0, 0, 50, 50), ("D44", 0, 0, 50, 50), ("D50", 0, 0, 50, 50)]), [])

    def test_clamps_to_the_image_and_fixes_swapped_corners(self):
        # box sticks out of the image and has xmin > xmax
        (line,) = self.lines(100, 100, [("D40", 120, -10, 80, 50)])
        cls, cx, cy, w, h = line.split()
        self.assertEqual(cls, "0")
        self.assertAlmostEqual(float(cx), 0.9, places=5)  # x from 80 to 100 (clamped)
        self.assertAlmostEqual(float(w), 0.2, places=5)
        self.assertAlmostEqual(float(cy), 0.25, places=5)  # y from 0 (clamped) to 50
        self.assertAlmostEqual(float(h), 0.5, places=5)

    def test_drops_boxes_that_are_tiny_or_collapse_outside_the_image(self):
        self.assertEqual(self.lines(100, 100, [("D40", 10, 10, 12, 12), ("D40", 150, 150, 200, 200)]), [])

    def test_every_value_is_in_range(self):
        for line in self.lines(640, 480, [("D00", 5, 5, 630, 470), ("D40", 0, 0, 640, 480)]):
            self.assertTrue(all(0.0 <= float(v) <= 1.0 for v in line.split()[1:]), line)

    def test_broken_files_raise(self):
        with self.assertRaises(ET.ParseError):
            ds.voc_to_yolo_lines(write(self.tmp / "bad.xml", "<annotation>"))
        with self.assertRaises(ValueError):
            ds.voc_to_yolo_lines(write(self.tmp / "nosize.xml", "<annotation></annotation>"))
        with self.assertRaises(ValueError):
            ds.voc_to_yolo_lines(write(self.tmp / "zero.xml", voc_xml(0, 0, [])))


class Splitting(unittest.TestCase):
    def test_disjoint_complete_and_close_to_the_requested_fraction(self):
        stems = [f"img_{i:05d}" for i in range(1000)]
        train, val = ds.split_by_blocks(stems, 0.15, block=40)
        self.assertEqual(set(train) & set(val), set())
        self.assertEqual(set(train) | set(val), set(stems))
        self.assertAlmostEqual(len(val) / len(stems), 0.15, delta=0.05)

    def test_val_is_made_of_contiguous_blocks_not_scattered_frames(self):
        stems = [f"img_{i:05d}" for i in range(800)]
        _, val = ds.split_by_blocks(stems, 0.2, block=40)
        positions = sorted(int(s.split("_")[1]) for s in val)
        runs = 1 + sum(1 for a, b in zip(positions, positions[1:]) if b != a + 1)
        self.assertLessEqual(runs, len(positions) / 40 + 1)  # one run per block at most

    def test_deterministic_and_seedable(self):
        stems = [f"s{i:04d}" for i in range(300)]
        self.assertEqual(ds.split_by_blocks(stems, seed=1), ds.split_by_blocks(stems, seed=1))
        self.assertNotEqual(ds.split_by_blocks(stems, seed=1)[1], ds.split_by_blocks(stems, seed=2)[1])

    def test_tiny_inputs(self):
        self.assertEqual(ds.split_by_blocks([], 0.15), ([], []))
        train, val = ds.split_by_blocks(["a", "b", "c"], 0.15, block=40)
        self.assertEqual(sorted(train + val), ["a", "b", "c"])


class EndToEnd(unittest.TestCase):
    def build_rdd(self, root: Path):
        """Two countries, 60 + 20 images. Every 3rd image has a pothole, every 3rd+1 a crack and a D43 (ignored), the rest are clean."""
        for country, n in (("Czech", 60), ("Norway", 20)):
            for i in range(n):
                stem = f"{country}_{i:06d}"
                write(root / country / "train" / "images" / f"{stem}.jpg", "jpeg")
                if i % 3 == 0:
                    boxes = [("D40", 10, 10, 60, 60)]
                elif i % 3 == 1:
                    boxes = [("D00", 5, 5, 90, 20), ("D43", 1, 1, 50, 50)]
                else:
                    boxes = [("D43", 1, 1, 50, 50)]
                write(root / country / "train" / "annotations" / "xmls" / f"{stem}.xml", voc_xml(100, 100, boxes))
        write(root / "Czech" / "test" / "images" / "Czech_999999.jpg", "jpeg")  # test images have no xml: must be ignored

    def test_convert_everything(self):
        tmp = Path(tempfile.mkdtemp())
        src, dst = tmp / "RDD2022", tmp / "out"
        self.build_rdd(src)
        counts = ds.convert_rdd2022(src, dst, val_fraction=0.25)

        self.assertEqual(counts["train"] + counts["val"], 80)
        self.assertGreater(counts["val"], 5)
        self.assertEqual(counts["skipped_bad_xml"], 0)
        # 80 images: i%3==0 -> pothole (27 + 7 = 34? computed below), i%3==1 -> crack; i%3==2 -> negative (only D43)
        potholes = sum(1 for n in (60, 20) for i in range(n) if i % 3 == 0)
        cracks = sum(1 for n in (60, 20) for i in range(n) if i % 3 == 1)
        negatives = 80 - potholes - cracks
        self.assertEqual(counts["boxes_pothole"], potholes)
        self.assertEqual(counts["boxes_crack"], cracks)
        self.assertEqual(counts["negatives"], negatives)
        self.assertEqual(ds.check_no_leakage(dst), [])

        # every image has a label file with the same stem, in the same split
        for split in ("train", "val"):
            images = {p.stem for p in (dst / "images" / split).glob("*")}
            labels = {p.stem for p in (dst / "labels" / split).glob("*.txt")}
            self.assertEqual(images, labels)
        hist = ds.class_histogram(dst)
        self.assertEqual(hist["train"]["pothole"] + hist["val"]["pothole"], potholes)
        self.assertEqual(hist["train"]["flooded_road"], 0)  # RDD2022 has no flooded roads: that data must be added separately

    def test_drop_negatives(self):
        tmp = Path(tempfile.mkdtemp())
        self.build_rdd(tmp / "r")
        counts = ds.convert_rdd2022(tmp / "r", tmp / "o", keep_negatives=False)
        self.assertEqual(counts["negatives"], 0)
        self.assertEqual(counts["train"] + counts["val"], sum(1 for n in (60, 20) for i in range(n) if i % 3 != 2))

    def test_a_corrupt_annotation_is_skipped_and_counted_not_fatal(self):
        tmp = Path(tempfile.mkdtemp())
        self.build_rdd(tmp / "r")
        write(tmp / "r" / "Czech" / "train" / "annotations" / "xmls" / "Czech_000000.xml", "<annotation>")
        counts = ds.convert_rdd2022(tmp / "r", tmp / "o")
        self.assertEqual(counts["skipped_bad_xml"], 1)
        self.assertEqual(counts["train"] + counts["val"], 79)

    def test_symlink_mode_does_not_copy_image_bytes(self):
        tmp = Path(tempfile.mkdtemp())
        self.build_rdd(tmp / "r")
        ds.convert_rdd2022(tmp / "r", tmp / "o", link=True)
        links = [p for p in (tmp / "o" / "images").rglob("*.jpg") if p.is_symlink()]
        self.assertGreater(len(links), 70)

    def test_data_yaml_has_the_class_order_the_app_expects(self):
        tmp = Path(tempfile.mkdtemp())
        text = ds.write_data_yaml(tmp).read_text()
        self.assertIn("nc: 3", text)
        self.assertLess(text.index("0: pothole"), text.index("1: crack"))
        self.assertLess(text.index("1: crack"), text.index("2: flooded_road"))
        self.assertEqual(ds.CLASSES, ["pothole", "crack", "flooded_road"])


class FoldInYoloFolder(unittest.TestCase):
    def test_remaps_classes_drops_unknown_ones_and_splits_in_blocks(self):
        tmp = Path(tempfile.mkdtemp())
        src, dst = tmp / "flood_raw", tmp / "out"
        for i in range(100):
            write(src / "images" / "train" / f"f{i:03d}.jpg", "jpeg")
            # their class 0 = flood, their class 5 = something we do not want
            write(src / "labels" / "train" / f"f{i:03d}.txt", "0 0.5 0.6 0.4 0.2\n5 0.1 0.1 0.1 0.1\n")
        write(src / "images" / "train" / "orphan.jpg", "jpeg")  # no label file: skipped and counted

        counts = ds.add_yolo_folder(src, dst, class_map={0: 2}, prefix="flood", val_fraction=0.2)
        self.assertEqual(counts["train"] + counts["val"], 100)
        self.assertEqual(counts["boxes"], 100)
        self.assertEqual(counts["dropped_boxes"], 100)
        self.assertEqual(counts["images_without_label"], 1)
        self.assertGreater(counts["val"], 10)
        self.assertEqual(ds.check_no_leakage(dst), [])
        hist = ds.class_histogram(dst)
        self.assertEqual(hist["train"]["flooded_road"] + hist["val"]["flooded_road"], 100)
        self.assertEqual(hist["train"]["pothole"] + hist["train"]["crack"], 0)
        one = next((dst / "labels" / "train").glob("flood_*.txt")).read_text().split()
        self.assertEqual(one[0], "2")
        self.assertEqual([float(v) for v in one[1:]], [0.5, 0.6, 0.4, 0.2])

    def test_labels_next_to_images_and_flat_layouts_are_found(self):
        tmp = Path(tempfile.mkdtemp())
        write(tmp / "a" / "x.jpg", "j")
        write(tmp / "a" / "x.txt", "0 0.5 0.5 0.2 0.2\n")
        write(tmp / "b" / "images" / "y.jpg", "j")
        write(tmp / "b" / "labels" / "y.txt", "0 0.5 0.5 0.2 0.2\n")
        for name in ("a", "b"):
            counts = ds.add_yolo_folder(tmp / name, tmp / f"out_{name}", {0: 2}, prefix=name, val_fraction=0.0)
            self.assertEqual(counts["train"] + counts["val"], 1, name)

    def test_segmentation_polygons_become_their_bounding_box(self):
        tmp = Path(tempfile.mkdtemp())
        write(tmp / "src" / "images" / "a.jpg", "j")
        # a crack polygon from (0.2, 0.1) to (0.4, 0.9): box centre (0.3, 0.5), size 0.2 x 0.8
        write(tmp / "src" / "labels" / "a.txt", "0 0.2 0.1 0.25 0.5 0.4 0.9 0.3 0.6\n")
        counts = ds.add_yolo_folder(tmp / "src", tmp / "out", {0: 1}, prefix="crack", val_fraction=0.0)
        self.assertEqual(counts["boxes"], 1)
        line = (tmp / "out" / "labels" / "train" / "crack_images_a.txt").read_text().split()
        self.assertEqual(line[0], "1")
        for got, want in zip((float(v) for v in line[1:]), (0.3, 0.5, 0.2, 0.8)):
            self.assertAlmostEqual(got, want, places=5)


class LabelParts(unittest.TestCase):
    def test_boxes_polygons_and_garbage(self):
        self.assertEqual(ds.label_parts_to_box("0 0.5 0.5 0.2 0.1".split()), (0.5, 0.5, 0.2, 0.1))
        cx, cy, w, h = ds.label_parts_to_box("0 0 0 1 0 1 1".split())
        self.assertEqual((cx, cy, w, h), (0.5, 0.5, 1.0, 1.0))
        self.assertIsNone(ds.label_parts_to_box("0 0.1 0.2 0.3 0.4 0.5".split()))  # odd number of polygon values
        self.assertIsNone(ds.label_parts_to_box("0 0.5 0.5 0 0.1".split()))  # zero width
        self.assertIsNone(ds.label_parts_to_box("0 0.3 0.3 0.3 0.3 0.3 0.3".split()))  # polygon collapsed to a point

    def test_polygon_points_outside_the_image_are_clamped(self):
        cx, cy, w, h = ds.label_parts_to_box("0 -0.2 0.5 0.6 0.5 0.6 1.3".split())
        self.assertAlmostEqual(cx, 0.3)
        self.assertAlmostEqual(w, 0.6)
        self.assertAlmostEqual(cy + h / 2, 1.0)


class FoldInPublishedSplits(unittest.TestCase):
    def make(self, root: Path, layout: str, split: str, n: int, label: str = "0 0.5 0.5 0.2 0.2\n"):
        for i in range(n):
            images = root / split / "images" if layout == "roboflow" else root / "images" / split
            labels = root / split / "labels" if layout == "roboflow" else root / "labels" / split
            write(images / f"{split}{i:03d}.jpg", "j")
            write(labels / f"{split}{i:03d}.txt", label)

    def test_keeps_the_published_split_maps_valid_to_val_and_caps_with_a_seeded_sample(self):
        tmp = Path(tempfile.mkdtemp())
        pot, crack, out = tmp / "pothole", tmp / "crack", tmp / "out"
        for split, n in (("train", 30), ("valid", 8), ("test", 5)):
            self.make(pot, "roboflow", split, n)
        for split, n in (("train", 50), ("val", 6), ("test", 4)):
            self.make(crack, "ultralytics", split, n, label="0 0.1 0.1 0.3 0.1 0.3 0.4\n")
        a = ds.add_yolo_splits(pot, out, {0: 0}, prefix="pothole")
        b = ds.add_yolo_splits(crack, out, {0: 1}, prefix="crack", limits={"train": 20})
        self.assertEqual((a["train"], a["val"], a["test"]), (30, 8, 5))
        self.assertEqual((b["train"], b["val"], b["test"]), (20, 6, 4))
        hist = ds.class_histogram(out)
        self.assertEqual(hist["test"], {"images": 9, "pothole": 5, "crack": 4, "flooded_road": 0})
        self.assertEqual(hist["train"]["crack"], 20)
        self.assertEqual(ds.check_no_leakage(out), [])
        self.assertIn("test: images/test", ds.write_data_yaml(out).read_text())
        again = ds.add_yolo_splits(crack, tmp / "out2", {0: 1}, prefix="crack", limits={"train": 20})
        self.assertEqual(sorted(p.name for p in (tmp / "out2" / "images" / "train").iterdir()),
                         sorted(p.name for p in (out / "images" / "train").iterdir() if p.name.startswith("crack_")))
        self.assertEqual(again["train"], 20)

    def test_leakage_across_test_is_reported(self):
        tmp = Path(tempfile.mkdtemp())
        write(tmp / "images" / "train" / "x.jpg", "j")
        write(tmp / "images" / "test" / "x.jpg", "j")
        self.assertEqual(ds.check_no_leakage(tmp), ["x"])


if __name__ == "__main__":
    unittest.main()
