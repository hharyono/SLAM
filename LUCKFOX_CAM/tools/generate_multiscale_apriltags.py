#!/usr/bin/env python3
"""Generate the exact A4 multi-AprilTag landing pad used by Landing.yaml."""

from pathlib import Path

import cv2
import numpy as np
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.pdfgen import canvas


ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "Calibration" / "a4_three_tag_landing_pad_ids_0_1_2_blue.pdf"
INK_RGB = (0.0, 0.0, 0.72)  # dark blue; low grayscale luminance for detection

# Same top-left A4 origin and outer-black-square dimensions as Landing.yaml.
TAGS = (
    {"name": "large", "id": 0, "x": 5, "y": 5, "size": 200},
    {"name": "medium", "id": 1, "x": 5, "y": 215, "size": 76},
    {"name": "small", "id": 2, "x": 89, "y": 215, "size": 54},
)
LANDING_CENTER = (116, 205)


def modules(tag_id: int) -> np.ndarray:
    dictionary = cv2.aruco.getPredefinedDictionary(cv2.aruco.DICT_APRILTAG_36h11)
    count = int(dictionary.markerSize) + 2
    image = cv2.aruco.generateImageMarker(dictionary, tag_id, count * 32, borderBits=1)
    return np.array([
        [image[row * 32 + 16, col * 32 + 16] for col in range(count)]
        for row in range(count)
    ])


def draw_tag(pdf: canvas.Canvas, tag: dict) -> None:
    page_h = A4[1]
    size = tag["size"] * mm
    x0 = tag["x"] * mm
    # YAML measures Y downward from paper top; ReportLab measures upward.
    y0 = page_h - (tag["y"] + tag["size"]) * mm
    grid = modules(tag["id"])
    cell = size / grid.shape[0]
    pdf.setFillColorRGB(*INK_RGB)
    for row in range(grid.shape[0]):
        for col in range(grid.shape[1]):
            if grid[row, col] < 128:
                pdf.rect(x0 + col * cell,
                         y0 + (grid.shape[0] - 1 - row) * cell,
                         cell + 0.015, cell + 0.015, stroke=0, fill=1)


def validate_layout() -> None:
    for tag in TAGS:
        assert 0 <= tag["x"] and tag["x"] + tag["size"] <= 210
        assert 0 <= tag["y"] and tag["y"] + tag["size"] <= 297
    assert len({tag["id"] for tag in TAGS}) == len(TAGS)
    assert [(tag["id"], tag["size"]) for tag in TAGS] == [(0, 200), (1, 76), (2, 54)]
    assert LANDING_CENTER == (116, 205)


def main() -> None:
    validate_layout()
    OUT.parent.mkdir(parents=True, exist_ok=True)
    pdf = canvas.Canvas(str(OUT), pagesize=A4, pageCompression=1)
    pdf.setTitle("A4 precision landing pad - blue AprilTag 36h11 IDs 0, 1, 2")
    pdf.setAuthor("LUCKFOX_CAM precision landing")
    pdf.setSubject("Outer black squares: ID0 200 mm, ID1 76 mm, ID2 54 mm")
    pdf.setFillColorRGB(1, 1, 1)
    pdf.rect(0, 0, A4[0], A4[1], stroke=0, fill=1)
    for tag in TAGS:
        draw_tag(pdf, tag)

    # Scale check in unused paper area; landing centre remains unmarked.
    pdf.setStrokeColorRGB(*INK_RGB)
    x0, y0 = 153 * mm, A4[1] - 285 * mm
    pdf.setLineWidth(0.35)
    pdf.line(x0, y0, x0 + 50 * mm, y0)
    pdf.line(x0, y0 - 1.5 * mm, x0, y0 + 1.5 * mm)
    pdf.line(x0 + 50 * mm, y0 - 1.5 * mm, x0 + 50 * mm, y0 + 1.5 * mm)
    pdf.setFillColorRGB(*INK_RGB)
    pdf.setFont("Helvetica", 6)
    pdf.drawCentredString(x0 + 25 * mm, y0 + 2.2 * mm, "50 mm print check")
    pdf.showPage()
    pdf.save()
    print(OUT)
    for tag in TAGS:
        print(f"{tag['name']}: ID {tag['id']}, {tag['size']} mm, top-left=({tag['x']},{tag['y']}) mm")
    print(f"landing centre: {LANDING_CENTER} mm (not printed)")
    print("Print with Actual size / 100%; disable Fit, Shrink, and Scale.")


if __name__ == "__main__":
    main()
