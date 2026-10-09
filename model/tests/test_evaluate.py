"""Run with:  python -m unittest discover -s model/tests -v"""

import math
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import evaluate as ev  # noqa: E402

CLASSES = ["pothole", "crack", "flooded_road"]


def b(cls, x, y, w=20, h=20, conf=1.0):
    return ev.Box(cls, x, y, x + w, y + h, conf)


class Matching(unittest.TestCase):
    def test_iou(self):
        self.assertAlmostEqual(ev.iou(b(0, 0, 0), b(0, 0, 0)), 1.0)
        self.assertEqual(ev.iou(b(0, 0, 0), b(0, 100, 100)), 0.0)
        self.assertAlmostEqual(ev.iou(b(0, 0, 0, 20, 20), b(0, 10, 0, 20, 20)), 1 / 3)

    def test_yolo_line_to_box(self):
        box = ev.yolo_line_to_box("1 0.5 0.5 0.2 0.4", 100, 200)
        self.assertEqual((box.cls, box.x1, box.y1, box.x2, box.y2), (1, 40.0, 60.0, 60.0, 140.0))

    def test_one_truth_can_be_matched_only_once(self):
        truth = [b(0, 0, 0)]
        preds = [b(0, 0, 0, conf=0.9), b(0, 1, 1, conf=0.8)]  # a duplicate: the second one is a false positive
        self.assertEqual(ev.count_matches(preds, truth), (1, 1, 0))

    def test_miss_and_wrong_place(self):
        self.assertEqual(ev.count_matches([b(0, 200, 200, conf=0.9)], [b(0, 0, 0)]), (0, 1, 1))
        self.assertEqual(ev.count_matches([], [b(0, 0, 0), b(0, 50, 50)]), (0, 0, 2))

    def test_higher_confidence_prediction_gets_the_ground_truth_first(self):
        truth = [b(0, 0, 0)]
        preds = [b(0, 5, 5, conf=0.4), b(0, 0, 0, conf=0.9)]
        tp, fp, fn = ev.count_matches(preds, truth)
        self.assertEqual((tp, fp, fn), (1, 1, 0))


class Curves(unittest.TestCase):
    def setUp(self):
        # image 1: a real pothole found with 0.9, plus a confident false alarm 0.6 and a weak false alarm 0.2
        # image 2: a pothole found weakly (0.35); a crack found with 0.8
        self.images = [
            ([b(0, 0, 0, conf=0.9), b(0, 200, 200, conf=0.6), b(0, 300, 300, conf=0.2)], [b(0, 0, 0)]),
            ([b(0, 0, 0, conf=0.35), b(1, 50, 50, conf=0.8)], [b(0, 0, 0), b(1, 50, 50)]),
        ]

    def test_precision_and_recall_at_each_threshold(self):
        r = ev.precision_recall(self.images, CLASSES, [0.1, 0.3, 0.5, 0.7, 0.95])["pothole"]
        by = {row["threshold"]: row for row in r}
        self.assertEqual((by[0.1]["tp"], by[0.1]["fp"], by[0.1]["fn"]), (2, 2, 0))  # 2 found, 2 false alarms (0.6, 0.2)
        self.assertAlmostEqual(by[0.1]["precision"], 0.5)
        self.assertAlmostEqual(by[0.1]["recall"], 1.0)
        self.assertEqual((by[0.3]["tp"], by[0.3]["fp"]), (2, 1))  # the 0.2 false alarm is gone
        self.assertEqual((by[0.5]["tp"], by[0.5]["fp"], by[0.5]["fn"]), (1, 1, 1))  # the weak true one is gone too
        self.assertEqual((by[0.7]["tp"], by[0.7]["fp"], by[0.7]["fn"]), (1, 0, 1))
        self.assertTrue(math.isnan(by[0.95]["precision"]))  # nothing predicted: precision undefined, recall 0
        self.assertEqual(by[0.95]["recall"], 0.0)

    def test_recall_never_increases_with_the_threshold(self):
        rows = ev.precision_recall(self.images, CLASSES, [i / 20 for i in range(1, 20)])["pothole"]
        recalls = [r["recall"] for r in rows]
        self.assertEqual(recalls, sorted(recalls, reverse=True))

    def test_classes_are_scored_separately(self):
        r = ev.precision_recall(self.images, CLASSES, [0.5])
        self.assertEqual((r["crack"][0]["tp"], r["crack"][0]["fp"], r["crack"][0]["fn"]), (1, 0, 0))
        self.assertTrue(math.isnan(r["flooded_road"][0]["precision"]) and math.isnan(r["flooded_road"][0]["recall"]))

    def test_pick_threshold_takes_the_lowest_one_that_is_precise_enough(self):
        rows = ev.precision_recall(self.images, CLASSES, [0.1, 0.3, 0.5, 0.7])["pothole"]
        self.assertEqual(ev.pick_threshold(rows, 0.6), 0.3)  # precision 2/3 at 0.3
        self.assertEqual(ev.pick_threshold(rows, 0.99), 0.7)
        self.assertIsNone(ev.pick_threshold(rows[:1], 0.9))

    def test_table_prints(self):
        text = ev.format_table(ev.precision_recall(self.images, CLASSES, [0.3, 0.7]))
        self.assertIn("pothole", text)
        self.assertIn("threshold", text)


if __name__ == "__main__":
    unittest.main()
