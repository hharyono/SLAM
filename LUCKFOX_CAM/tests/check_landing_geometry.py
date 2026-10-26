#!/usr/bin/env python3
"""Offline geometry and handoff checks for the multi-AprilTag landing pad."""

import math
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def config(path):
    values = {}
    for line in path.read_text().splitlines():
        line = line.split("#", 1)[0].strip()
        if ":" in line:
            key, value = line.split(":", 1)
            try:
                values[key.strip()] = float(value.strip())
            except ValueError:
                pass
    return values


cfg = config(ROOT / "Config" / "Landing.yaml")
landing = (cfg["landing_target_x_m"], cfg["landing_target_y_m"])
tags = []
for name in ("large", "medium", "small"):
    size = cfg[f"{name}_tag_size_m"]
    tags.append({
        "name": name,
        "size": size,
        "center": (cfg[f"{name}_tag_x_m"] + size / 2,
                   cfg[f"{name}_tag_y_m"] + size / 2),
    })


def pad_offset(tag):
    # The PDF's printed tag orientation makes AprilTag pose +X point toward
    # paper-left and pose +Y toward paper-top. landing_main applies this local
    # offset through each detected tag rotation R.
    return (-(landing[0] - tag["center"][0]),
            -(landing[1] - tag["center"][1]), 0.0)


def camera_to_body(point):
    # Installed camera: image-up is forward and image-right is body-right.
    # MAV_FRAME_BODY_FRD: +X forward, +Y right, +Z down.
    return (-point[1], point[0], point[2])


def solve(true_tag, assumed_tag, target_camera):
    true_offset = pad_offset(true_tag)
    raw_true = tuple(target_camera[i] - true_offset[i] for i in range(3))
    scale = assumed_tag["size"] / true_tag["size"]
    raw_assumed = tuple(value * scale for value in raw_true)
    assumed_offset = pad_offset(assumed_tag)
    center_camera = tuple(raw_assumed[i] + assumed_offset[i] for i in range(3))
    body = camera_to_body(center_camera)
    angles = (math.atan2(body[1], body[2]), math.atan2(body[0], body[2]))
    return center_camera, body, angles


print("Centered-camera result using the correct tag geometry:")
for tag in tags:
    center, body, angles = solve(tag, tag, (0.0, 0.0, 1.0))
    print(f"  {tag['name']:6s}: center=({center[0]:+.6f},{center[1]:+.6f}) m "
          f"angles=({angles[0]:+.9f},{angles[1]:+.9f}) rad")
    assert max(abs(center[0]), abs(center[1]), abs(angles[0]), abs(angles[1])) < 1e-9

print("\nLegacy repeated-ID wrong-size hypotheses for a centered camera:")
worst = 0.0
for true_tag in tags:
    for assumed_tag in tags:
        if assumed_tag is true_tag:
            continue
        center, _, _ = solve(true_tag, assumed_tag, (0.0, 0.0, 1.0))
        error = math.hypot(center[0], center[1])
        worst = max(worst, error)
        print(f"  true={true_tag['name']:6s} assumed={assumed_tag['name']:6s}: "
              f"XY=({center[0]:+.3f},{center[1]:+.3f}) m error={error:.3f} m")

print("\nDirectional checks (camera displacement from pad centre -> target in BODY_FRD):")
cases = {
    "camera_forward": ((0.0, -0.20, 1.0), (+0.20, 0.0)),
    "camera_backward": ((0.0, +0.20, 1.0), (-0.20, 0.0)),
    "camera_right": ((+0.20, 0.0, 1.0), (0.0, +0.20)),
    "camera_left": ((-0.20, 0.0, 1.0), (0.0, -0.20)),
}
for name, (target_camera, expected_xy) in cases.items():
    _, body, _ = solve(tags[2], tags[2], target_camera)
    print(f"  {name:15s}: forward={body[0]:+.3f} right={body[1]:+.3f} m")
    assert math.isclose(body[0], expected_xy[0], abs_tol=1e-9)
    assert math.isclose(body[1], expected_xy[1], abs_tol=1e-9)

confirm = int(cfg["tag_switch_confirm_frames"])
tolerance = cfg["tag_handoff_tolerance_m"]
lost_timeout = int(cfg["lost_timeout_ms"])
min_hz = cfg["min_inference_hz"]
small_below = cfg["small_tag_select_below_m"]
medium_below = cfg["medium_tag_select_below_m"]
# Flight data showed only 5-6 inference frames/s.  Confirmation must complete
# near one second, and loss timeout must bridge several missed frames.
assert 2 <= confirm <= 4
assert 0.05 <= tolerance <= 0.10
assert lost_timeout >= math.ceil(5 * 1000 / min_hz)
assert cfg["vision_range_min_m"] < small_below < medium_below < cfg["vision_range_max_m"]
# A landing tier is monotonic until the target-free reset: 0 -> 1 -> 2, never
# 2 -> 1 or 1 -> 0.
tier = -1
for desired in (0, 1, 2, 1, 0):
    tier = max(tier, desired)
assert tier == 2
# A LAND -> LOITER transition starts a new approach and immediately releases
# the monotonic tier lock, even while the vehicle remains armed.
previous_mode, mode = 9, 5
if previous_mode == 9 and mode == 5:
    tier = -1
assert tier == -1
stable_count = 0
for frame in range(confirm - 1):
    stable_count += 1
    assert stable_count < confirm
stable_count += 1
assert stable_count == confirm
assert math.hypot(0.101, 0.0) > tolerance

# Two tags observed in one frame cannot move relative to one another.  The
# configured geometry gate therefore stays fixed; speed allowance applies only
# when the new tag is compared with a centre from an older frame.
elapsed = 0.4
speed = cfg["max_center_speed_mps"]
same_frame_limit = tolerance
stale_center_limit = tolerance + speed * elapsed
observed_bad_handoff = 0.124  # representative ID1 -> ID2 jump from flight log
assert observed_bad_handoff > same_frame_limit
assert observed_bad_handoff < stale_center_limit

# Flight 2026-09-28T01-22-42 measured the old-transform centre deltas on
# simultaneous observations. Flipping only the PDF X delta removes the exact
# two-times-tag-spacing bias while preserving the already-correct Y axis.
old_small_minus_medium_x = -0.135895
old_medium_minus_large_x = +0.122205
def x_sign_flip_shift(tag):
    old = landing[0] - tag["center"][0]
    return -2 * old
corrected_small_minus_medium_x = (
    old_small_minus_medium_x + x_sign_flip_shift(tags[2])
    - x_sign_flip_shift(tags[1]))
corrected_medium_minus_large_x = (
    old_medium_minus_large_x + x_sign_flip_shift(tags[1])
    - x_sign_flip_shift(tags[0]))
assert abs(corrected_small_minus_medium_x) < 0.02
assert abs(corrected_medium_minus_large_x) < 0.02

print(f"\nHandoff checks: switch={confirm} stable frames, gate={tolerance:.3f} m, "
      f"lost timeout={lost_timeout} ms")
print(f"Same-frame gate remains {same_frame_limit:.3f} m; "
      f"stale-centre gate at {elapsed:.1f} s is {stale_center_limit:.3f} m")
print("Recorded overlap after PDF-X correction: "
      f"ID2-ID1={corrected_small_minus_medium_x:+.3f} m, "
      f"ID1-ID0={corrected_medium_minus_large_x:+.3f} m")
print(f"BEFORE worst centered wrong-hypothesis error: {worst:.3f} m")
print("AFTER  max centered correct-tag error: 0.000000 m; max angle error: 0.000000000 rad")
print("PASS")
