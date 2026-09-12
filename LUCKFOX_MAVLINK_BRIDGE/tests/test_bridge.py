#!/usr/bin/env python3
"""Linux PTY/TCP integration tests, using only Python's standard library."""
import concurrent.futures
import errno
import os
from pathlib import Path
import pty
import select
import socket
import subprocess
import sys
import tempfile
import time

BINARY = sys.argv[1]


def wait_until(predicate, timeout=5):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if predicate():
            return
        time.sleep(0.02)
    raise AssertionError("condition timed out")


def write_fd(fd, data):
    end = time.monotonic() + 8
    while data:
        if time.monotonic() > end:
            raise AssertionError("serial write timeout")
        if select.select([], [fd], [], 0.1)[1]:
            try:
                n = os.write(fd, data)
                data = data[n:]
            except BlockingIOError:
                pass


def read_fd(fd, length):
    result = bytearray()
    end = time.monotonic() + 8
    while len(result) < length and time.monotonic() < end:
        if select.select([fd], [], [], 0.1)[0]:
            result.extend(os.read(fd, length-len(result)))
    assert len(result) == length, (len(result), length)
    return bytes(result)


def read_tcp(sock, length):
    result = bytearray()
    while len(result) < length:
        chunk = sock.recv(length-len(result))
        assert chunk, "unexpected disconnect"
        result.extend(chunk)
    return bytes(result)


def crc(data):
    value = 0xffff
    for byte in data:
        tmp = byte ^ (value & 0xff)
        tmp ^= (tmp << 4) & 0xff
        value = ((value >> 8) ^ (tmp << 8) ^ (tmp << 3) ^ (tmp >> 4)) & 0xffff
    return value.to_bytes(2, "little")


def heartbeat(version, seq, signed=False):
    payload = bytes([0, 0, 0, 0, 2, 3, 0, 4, 3])
    if version == 1:
        header = bytes([0xfe, len(payload), seq, 1, 1, 0])
    else:
        header = bytes([0xfd, len(payload), int(signed), 0, seq, 1, 1, 0, 0, 0])
    frame = header + payload + crc(header[1:] + payload + bytes([50]))
    # Opaque signature bytes: the bridge must preserve, not authenticate them.
    return frame + (bytes(range(13)) if signed else b"")


with tempfile.TemporaryDirectory(prefix="mavlink-bridge-") as directory:
    root = Path(directory)
    uart = root / "uart"
    log = root / "bridge.log"
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
    for args in [["--port", "0"], ["--port", "65536"], ["--baud", "123"],
                 ["--port", "-1"], ["--bind", "bad-ip"], ["--serial"]]:
        bad = subprocess.run([BINARY] + args, capture_output=True, timeout=3)
        assert bad.returncode != 0, args
    output = log.open("wb")
    process = subprocess.Popen([BINARY, "--serial", str(uart), "--bind", "127.0.0.1",
                                "--port", str(port)], stdout=output, stderr=output)
    descriptors = []
    clients = []
    def logged(text):
        assert process.poll() is None, log.read_text()
        return text in log.read_text()
    def connect():
        s = socket.create_connection(("127.0.0.1", port), timeout=3)
        s.settimeout(5)
        clients.append(s)
        return s
    def new_uart():
        master, slave = pty.openpty()
        os.set_blocking(master, False)
        descriptors.extend([master, slave])
        uart.unlink(missing_ok=True)
        uart.symlink_to(os.ttyname(slave))
        return master
    try:
        wait_until(lambda: logged("serial_retry="))
        no_uart = connect()
        assert no_uart.recv(1) == b"", "client accepted without serial"
        no_uart.close()
        master = new_uart()
        wait_until(lambda: logged("serial_connected="))
        first = connect()
        wait_until(lambda: logged("client_connected="))
        second = connect()
        assert second.recv(1) == b"", "second GCS was accepted"
        second.close()

        # MAVLink 1, MAVLink 2 and signed-shaped packets cross byte-for-byte.
        frames = heartbeat(1, 0) + heartbeat(2, 1) + heartbeat(2, 2, True)
        for fragment in [frames[:1], frames[1:8], frames[8:19], frames[19:]]:
            write_fd(master, fragment)
        assert read_tcp(first, len(frames)) == frames
        for fragment in [frames[:3], frames[3:4], frames[4:]]:
            first.sendall(fragment)
        assert read_fd(master, len(frames)) == frames

        # Full duplex with transfers much larger than either application queue.
        upstream = bytes(range(256)) * 1024
        downstream = bytes(reversed(range(256))) * 1024
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
            sent_uart = pool.submit(write_fd, master, upstream)
            got_tcp = pool.submit(read_tcp, first, len(upstream))
            sent_tcp = pool.submit(first.sendall, downstream)
            got_uart = pool.submit(read_fd, master, len(downstream))
            sent_uart.result(timeout=10)
            sent_tcp.result(timeout=10)
            assert got_tcp.result(timeout=10) == upstream
            assert got_uart.result(timeout=10) == downstream

        first.close()
        wait_until(lambda: logged("client_disconnected=tcp_closed"))
        write_fd(master, b"old telemetry that must not replay")
        time.sleep(0.15)
        old_count = log.read_text().count("client_connected=")
        third = connect()
        wait_until(lambda: log.read_text().count("client_connected=") > old_count)
        third.settimeout(0.2)
        try:
            assert not third.recv(128), "stale telemetry replayed"
            raise AssertionError("connection unexpectedly closed")
        except socket.timeout:
            pass
        third.settimeout(5)
        write_fd(master, frames)
        assert read_tcp(third, len(frames)) == frames

        # UART unplug closes GCS, then reconnects to a replacement device.
        os.close(master); descriptors.remove(master)
        wait_until(lambda: logged("serial_disconnected="))
        assert third.recv(1) == b""
        third.close()
        connected = log.read_text().count("serial_connected=")
        master = new_uart()
        wait_until(lambda: log.read_text().count("serial_connected=") > connected)
        old_count = log.read_text().count("client_connected=")
        fourth = connect()
        wait_until(lambda: log.read_text().count("client_connected=") > old_count)
        fourth.sendall(frames)
        assert read_fd(master, len(frames)) == frames

        # A client that stops reading is disconnected without unbounded memory.
        slow_start = log.stat().st_size
        end = time.monotonic()+5
        while time.monotonic() < end:
            if "tcp_queue_full" in log.read_text()[slow_start:] or "forwarding_stalled" in log.read_text()[slow_start:]:
                break
            write_fd(master, b"x"*4096)
        else:
            raise AssertionError("slow client was not disconnected")
        assert process.poll() is None
        process.terminate()
        assert process.wait(timeout=3) == 0
        print("PASS: arguments, serial retry, single client, MAVLink 1/2 byte preservation,")
        print("      full duplex/backpressure, TCP reconnect, serial reconnect, slow client, shutdown")
    finally:
        for client in clients:
            client.close()
        if process.poll() is None:
            process.kill(); process.wait(timeout=3)
        for fd in descriptors:
            os.close(fd)
        output.close()
        if process.returncode not in (0, None):
            print(log.read_text(), file=sys.stderr)
