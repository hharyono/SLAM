# Journal and Experiment Handoff — 2026-07-25

This file is the authoritative restart point for the next work session. It
preserves the technical state, scientific interpretation, and decisions made
on 2026-07-25 without relying on chat history.

## Repository state

- Branch: `JournalQ3Ready`
- Implementation/data commit before this handoff:
  `995d46df7d33c282e4b4e0a5476532cce6619ae5`
- Commit title: `feat: complete RV1103 resource replay telemetry`
- Dashboard backend: running on ports 8080, 42000, 42010, and 42020.
- Active experiment at close: none (`/api/experiments/active` returned `null`).
- Do not replace, discard, or rewrite Accepted raw evidence.

## Board state

- Primary publication target: RV1103 at `192.168.1.231`.
- `localize_uart` was running normally at close.
- Installed replay binary SHA-256:
  `69032f14c1cabbd5f0ee69d931e2ecfb69b8aad495fc635e4a7146e42b83f697`.
- Previous board replay binary is recoverable as
  `/usr/bin/localize_replay.prev`.
- Firmware permits only the production `local_global_multi` variant for board
  ablation/resource replay.
- Resource replay uses `recorded` pacing and restores `localize_uart`
  automatically after replay.

## Final RESOURCE design

The Resource page supports three independent modes:

1. Live Idle + Tracking (Idle, R1, R2).
2. Live Endurance with arbitrary START/END duration.
3. Recorded-paced replay of an Accepted RV1103 route/kidnapped dataset.

The replay telemetry format and analyzer now distinguish:

- end-to-end paced CPU;
- matcher-active CPU;
- total CPU time and replay wall time;
- pacing wait;
- matcher and scan-cycle latency;
- current/mean/P95/peak RSS;
- deadline misses;
- accepted/rejected scans;
- global scan count and recovery;
- final position/heading error and false recovery;
- execution target, pacing, source/map/binary hashes, and method variant.

Resource replay analysis must report `resource_telemetry_complete=true`.
Missing CPU, RSS, latency, or end-to-end paced CPU fields invalidate a new
Resource replay.

## Accepted RESOURCE evidence

### Live Idle + Tracking

`Accepted/RV1103/RESOURCE/20260725T063358Z_nominal_resource_01_198484089432`

- Idle 63.119 s; R1 61.432 s; R2 62.437 s.
- R1/R2 accepted-scan rate: 100%.
- No LOST/DEGRADED state.
- R1/R2 score means: 0.9790/0.9776.
- CPU means: Idle 0.57%, R1 60.89%, R2 60.96%.
- Peak RSS: 2,076 KiB while tracking.
- Scan-cycle P95: approximately 105 ms.

### Live Endurance

`Accepted/RV1103/RESOURCE/20260725T065307Z_nominal_resource_01_198484089432`

- Duration: 302.251 s.
- 2,999/2,999 scans accepted.
- No LOST/DEGRADED state.
- Tracking-sample rate: 99.97%.
- Score mean/minimum: 0.9527/0.9015.
- CPU mean/P95 derived from scan telemetry: 62.09%/66.04%.
- Peak RSS: 2,076 KiB.
- Matcher mean/P95: 59.43/65.25 ms.
- Scan-cycle mean/P95: 98.89/105.71 ms.
- 593/2,999 cycles (19.77%) exceeded 100 ms.
- Historical generated summary did not aggregate endurance CPU/RSS, although
  the values exist in raw scan telemetry. The analyzer has since been fixed
  for future sessions; do not modify this Accepted historical artifact.

### Complete RV1103 paced replay (authoritative replacement)

`Accepted/RV1103/RESOURCE/20260725T071433Z_nominal_resource_01_f90df293b555`

- Source: cross-room kidnapped experiment
  `20260725T013706Z_nominal_kidnapped_01_198484089432`.
- Protocol valid; `recorded` pacing; RV1103 target; only
  `local_global_multi`.
- Resource telemetry complete: 576/576 rows.
- Accepted scans: 569/576 (98.78%).
- Paced CPU mean/P95/max: 66.48%/82.26%/99.81%.
- Time-weighted CPU utilization: 66.05%.
- Matcher CPU mean/P95: 98.42%/99.94%.
- RSS mean/P95/peak: 1,456/1,456/1,456 KiB.
- Tracking latency mean/P95/max: 50.96/67.25/107.71 ms.
- Global latency mean/max: 866.24/1,110.28 ms.
- Deadline misses: 4/576 (0.69%).
- Recovery: 1,045 ms.
- Final error: 0.04998 m and 0.343 degrees.
- False recoveries: 0.
- Interpretation is stored inside the experiment as `INTERPRETATION.txt`.

The earlier incomplete replay
`20260725T070009Z_nominal_resource_01_f90df293b555` was removed from Accepted
and moved to the operating-system Trash as
`20260725T070009Z_nominal_resource_01_f90df293b555_replaced_incomplete`.
It is not publication evidence.

## Other Accepted evidence

- Host ablation: two Accepted sessions under `Accepted/Host/ABLATION`.
- RV1103 ablation: two Accepted sessions under `Accepted/RV1103/ABLATION`.
- RV1103 route: two Accepted sessions.
- RV1103 kidnapped: four Accepted sessions.
- RV1103 dynamic occlusion: two Accepted sessions.
- Dynamic occlusion tests concern obstacle passage at M2–M7; M1 and M8 are
  outside the obstacle-passage evaluation. A partial crossing is sufficient;
  the obstacle need not fill the scan.

## Scientific interpretation

The production method is `local_global_multi`.

Do not claim that scan matching, multi-resolution matching, or global
relocalization is individually a new algorithm. The research contribution is
the embedded system co-design and reproducible evaluation of their combined
behavior on constrained hardware.

Recommended central claim:

> A reproducible embedded localization-recovery architecture and evaluation
> methodology that reveals the accuracy-recovery-resource trade-off of
> local/global multi-resolution matching under physical disturbances and
> sensor-paced execution on constrained hardware.

Core findings:

1. Routine tracking fits within the 100 ms period at P95 in the complete paced
   replay.
2. Global recovery is the dominant exceptional computation cost.
3. Recovery succeeds in approximately one second with low final error and no
   false recovery.
4. Matcher-active CPU is about 98%, but real end-to-end paced CPU is about
   66%; the board is highly utilized while computing but is not continuously
   saturated across the sensor timeline.
5. Physical tests, ablation, live resource measurement, and deterministic
   board replay jointly connect robustness, accuracy, and embedded resource
   cost.

Plain-language interpretation:

- CPU matcher 98% means nearly one CPU core is occupied while matching a scan.
- CPU paced 66% includes the waiting time between sensor scans and represents
  the average real-time replay load.
- Deadline miss 0.69% means only 4 of 576 cycles exceeded 100 ms.
- Recovery 1.045 s is the time required to re-establish stable tracking after
  the kidnapped displacement.
- Final error 5 cm/0.343 degrees is the difference from the reference after
  recovery.
- Zero false recovery means the system did not claim recovery and then fall
  back to LOST.

## Publication decision

- The evidence is ready to begin writing now.
- Do not delay writing merely to establish a larger nominal test count.
- If a reviewer requests a specific additional experiment, run the requested
  scenario using the prepared FE/backend/firmware workflow.
- Primary strategy: write and submit at the standard of an applied Q2 journal
  in embedded robotics, mobile-robot localization, or real-time intelligent
  systems.
- Q3 is a strong fallback.
- Avoid theory-first SLAM journals that require a fundamentally new matching
  algorithm.
- Acceptance can never be guaranteed; the strongest Q2 positioning is the
  embedded co-design, reproducible protocol, and linked
  accuracy-recovery-resource analysis.

## Restart checklist

1. Read this file and the three RESOURCE `INTERPRETATION.txt` files.
2. Verify branch and working tree before editing.
3. Confirm RV1103 and the replay-binary hash only if new experiments will run.
4. Start manuscript work with title, research questions, contribution list,
   and Results section based on the Accepted tables.
5. Treat `TestPlanning-ID.html` as the operational protocol reference for
   Ablation and Resource.
6. Preserve all Accepted raw files and manifests unchanged.
