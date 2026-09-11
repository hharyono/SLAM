#!/usr/bin/env python3
"""Synthetic TCP scan -> bridge -> RF2O rotation check (no physical device).
Run with the ROS environment sourced after building both workspaces.
Uses an isolated ROS domain and a temporary TCP port.
"""
import math
import os
from pathlib import Path
import socket
import struct
import subprocess
import tempfile
import time

os.environ['ROS_DOMAIN_ID'] = '173'
import rclpy
from nav_msgs.msg import Odometry

ROOT = Path(__file__).resolve().parents[1]


def frame(sequence, yaw):
    count = 721
    increment = 2 * math.pi / (count - 1)
    points = []
    # Off-centre rectangular room: x in [-2, 4], y in [-3, 2].
    for index in range(count):
        angle = -math.pi + index * increment
        c, s = math.cos(angle + yaw), math.sin(angle + yaw)
        tx = (4 if c > 0 else -2) / c if abs(c) > 1e-9 else math.inf
        ty = (2 if s > 0 else -3) / s if abs(s) > 1e-9 else math.inf
        points.append(struct.pack('!fff', angle, min(tx, ty), 10))
    payload = struct.pack('!QfffffffI', sequence * 100_000_000,
                          -math.pi, math.pi, increment, 0.1 / count, 0.1, 0.1, 12., count)
    payload += b''.join(points)
    return struct.pack('!IHHII', 0x53434e31, 1, 1, len(payload), sequence) + payload


def main():
    with socket.socket() as reserve:
        reserve.bind(('127.0.0.1', 0))
        port = reserve.getsockname()[1]
    rclpy.init()
    node = rclpy.create_node('rotation_smoke')
    poses = []
    subscription = node.create_subscription(Odometry, '/odom_rf2o', poses.append, 10)
    processes = []
    connection = socket.socket()
    with tempfile.TemporaryFile(mode='w+') as log:
        try:
            commands = [
                ['ros2', 'run', 'tf2_ros', 'static_transform_publisher',
                 '0', '0', '0', '0', '0', '0', 'base_link', 'laser_frame'],
                [str(ROOT / 'Rf2oWs/install/rf2o_laser_odometry/lib/rf2o_laser_odometry/rf2o_laser_odometry_node'),
                 '--ros-args', '--params-file', str(ROOT / 'Rf2oWs/Config/Rf2o.yaml')],
                [str(ROOT / 'ScanTcpBridgeWs/install/scan_tcp_bridge/lib/scan_tcp_bridge/scan_tcp_bridge_node'),
                 '--ros-args', '-p', f'port:={port}', '-p', 'map_backend_port:=1'],
            ]
            for command in commands:
                processes.append(subprocess.Popen(command, stdout=log, stderr=log))
            deadline = time.monotonic() + 10
            while True:
                try:
                    connection.connect(('127.0.0.1', port))
                    break
                except ConnectionRefusedError:
                    if time.monotonic() > deadline:
                        raise
                    time.sleep(0.1)
            for sequence in range(60):
                yaw = max(0, min(30, sequence - 20)) * math.pi / 60
                connection.sendall(frame(sequence, yaw))
                deadline = time.monotonic() + 0.1
                while time.monotonic() < deadline:
                    rclpy.spin_once(node, timeout_sec=0.01)
            assert len(poses) >= 30, f'Insufficient odometry: {len(poses)}'
            pose = poses[-1].pose.pose
            q = pose.orientation
            yaw = math.atan2(2*(q.w*q.z + q.x*q.y), 1-2*(q.y*q.y+q.z*q.z))
            error = abs(yaw - math.pi / 2)
            drift = math.hypot(pose.position.x, pose.position.y)
            print(f'90 degree TCP rotation: estimated={math.degrees(yaw):.2f} deg, '
                  f'error={math.degrees(error):.2f} deg, drift={drift:.3f} m, poses={len(poses)}')
            assert error < math.radians(5), 'Rotation error exceeds 5 degrees'
            assert drift < 0.15, 'Pure rotation produces excessive translation'
        except Exception:
            log.seek(0)
            print(log.read()[-6000:])
            raise
        finally:
            connection.close()
            for process in processes:
                process.terminate()
            for process in processes:
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
            node.destroy_subscription(subscription)
            node.destroy_node()
            rclpy.shutdown()


if __name__ == '__main__':
    main()
