# Working robot state — 2026-09-13

This file records the configuration that produced the current usable SLAM and
ArduRover AUTO behavior. The numeric flight-controller snapshot is stored in
`AGV_DASHBOARD/backend/scripts/ardupilot_navigation_applied_2026-09-13.json`.

## Network and data paths

| Purpose | Active endpoint |
|---|---|
| RV1103 board | `192.168.1.50` |
| Dashboard telemetry | RV1103 to workstation TCP `42000` |
| Dashboard scan stream | RV1103 to workstation TCP `42010` |
| Mission Planner MAVLink | TCP `192.168.1.50:5760` |
| Dashboard mission upload/read | TCP `192.168.1.50:5761` |

The workstation address is network-dependent. At capture time the deployed
`/etc/default/localize_uart` used `192.168.1.71` for ports 42000 and 42010.
The Windows dashboard forwarder targets the fixed board address
`192.168.1.50`.

## RV1103 serial allocation

| Device | Function | Baud |
|---|---|---:|
| `/dev/ttyS3` | YDLidar | 230400 |
| `/dev/ttyS4` | MAVLink 2 `VISION_POSITION_ESTIMATE` to ArduPilot | 115200 |
| `/dev/ttyS5` | Bidirectional ArduPilot MAVLink bridge | 115200 |

The deployed processes were verified as:

```text
/usr/bin/localize_uart /etc/slam/ruang_utama.bin /dev/ttyS3 230400
/usr/bin/mavlink_bridge --serial /dev/ttyS5 --baud 115200 \
  --bind 0.0.0.0 --port 5760 --upload-port 5761
```

## Localizer state

- Map: `/etc/slam/ruang_utama.bin`
- Scan target: 10 Hz
- Angular search step: `0.008726646 rad` (0.5 degree)
- Angular search window: `0.35 rad`
- Linear search step/window: `0.05 m` / `0.5 m`
- Minimum match score: `0.72`
- MAVLink output: `/dev/ttyS4`, MAVLink 2, component ID 197
- Tracking loss/recovery does not reset the ExternalNav coordinate frame.
  Loading a different map does increment the MAVLink reset counter.
- A fresh `localize_uart` process seeds the reset counter from boot time so an
  ArduPilot EKF can distinguish a daemon restart.

## ArduPilot state

- Firmware observed: ArduRover 4.5.6
- EKF3 XY and yaw source: ExternalNav (`EK3_SRC1_POSXY=6`,
  `EK3_SRC1_YAW=6`)
- ExternalNav delay: 100 ms
- EKF origin used during this session:
  `-7.608038171102201, 110.93883455425673`
- Current waypoint tuning: `WP_RADIUS=0.30 m`, `WP_SPEED=0.25 m/s`
- Position controller: `PSC_POS_P=0.55`
- Velocity controller: `PSC_VEL_P=0.65`, `PSC_VEL_I=0.20`,
  `PSC_VEL_IMAX=1.0`
- Steering controller: angle P 4.0; rate P/I/FF 0.18/0.13/0.26
- Pivot: 10 degree trigger, 50 deg/s requested rate
- Motor minimum throttle: `MOT_THR_MIN=15%` so low-speed pivot output
  clears the drivetrain's measured static deadband.

`PSC_VEL_I=0.20` is intentional. With I at zero, the rover stopped about
0.33 m from an active waypoint: the controller output remained below the
drivetrain's effective movement threshold and the mission could not advance.
The small integral term lets output build gradually against static friction.

`PSC_POS_P=0.55` strengthens cross-track correction. At 0.20 the measured
heading agreed with the final WP10-to-WP11 leg within one degree, but the rover
still accumulated about 0.46 m of lateral error and passed beside WP11.

The JSON snapshot was read back from the flight controller over MAVLink 2. Its
`runtime` section only describes the instant it was captured (ARMED/AUTO); it
is not an instruction to arm automatically.

## Dashboard waypoint behavior

- Clicked map coordinates are uploaded with `MISSION_ITEM_INT` over MAVLink 2.
- Mission sequence 0 is reserved for ArduPilot HOME; user points start at 1.
- Upload and read use the configured EKF-origin latitude/longitude as a fixed
  map-to-global translation. Live SLAM and ArduPilot yaw still determine the
  frame rotation, but normal `GLOBAL_POSITION_INT` estimation error never
  translates the mission. A mission uploaded with this mapping reads back at
  the same map XY after restart and setting the same EKF origin.
- The uploader requests a 0.30 m waypoint acceptance radius, matching the live
  `WP_RADIUS` setting.
- Dashboard controls include Clear, EKF-origin latitude/longitude,
  **SET EKF ORIGIN HERE**, **SEND WP**, and **READ WP**.

Before a new map/session, set the EKF origin, confirm ExternalNav is accepted,
create or read the mission, and test while supervised. Parameter changes to
navigation and steering should be made while DISARMED.

## Relevant source locations

- Dashboard: `AGV_DASHBOARD/`
- Localizer: `LUCKFOX_LOCALIZER/`
- MAVLink bridge: `LUCKFOX_MAVLINK_BRIDGE/`
- RV1103 integration: `RV1103_BUILDROOT/`
- Shared localizer Buildroot package: `RV1106_BUILDROOT/package/luckfox-localizer/`

Only the application/package targets need rebuilding and deploying for these
components; a complete Buildroot image rebuild is not required for ordinary
`localize_uart` updates.
