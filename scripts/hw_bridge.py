#!/usr/bin/env python3
"""
Serial bridge between the ESP32 DevOps MCP server and the on-target
interrogation agent firmware (see firmware/interrogation-agent/).

Protocol
--------
The agent speaks newline-delimited JSON over the USB-serial link:

    host  -> target : {"id": 1, "op": "i2c.scan", "params": {...}}\n
    target -> host  : {"id": 1, "ok": true, "data": {...}}\n

This script performs exactly one request/response exchange per invocation and
prints a single JSON envelope on stdout:

    {"ok": true,  "data": {...}, "raw": "<verbatim agent line>"}
    {"ok": false, "error": "...", "errorKind": "TIMEOUT", "raw": "<whatever arrived>"}

Raw agent output is always included, even on failure, so the caller can retain
the unparsed observation.

Safety
------
This bridge only transports requests. It performs no bus operations of its own,
never writes flash, and never drives GPIO. Everything it can do is bounded by
what the agent firmware implements.

Usage
-----
    python3 hw_bridge.py --port /dev/ttyUSB0 --request '{"op":"sys.ping","params":{}}'
    python3 hw_bridge.py --check
"""

import argparse
import json
import sys
import time

# Errors the caller can act on differently, mirroring TransportErrorKind in TypeScript.
ERR_NO_TRANSPORT = "NO_TRANSPORT"
ERR_PORT_UNAVAILABLE = "PORT_UNAVAILABLE"
ERR_AGENT_NOT_PRESENT = "AGENT_NOT_PRESENT"
ERR_TIMEOUT = "TIMEOUT"
ERR_MALFORMED = "MALFORMED_RESPONSE"
ERR_INTERNAL = "INTERNAL"

MAX_RAW_CAPTURE = 65536


def emit(payload):
    """Print a single-line JSON envelope and exit successfully.

    The process exit code stays 0 for *protocol-level* failures so the caller
    reads the structured error rather than a generic non-zero exit.
    """
    sys.stdout.write(json.dumps(payload))
    sys.stdout.write("\n")
    sys.stdout.flush()


def fail(error, kind=ERR_INTERNAL, raw=""):
    emit({"ok": False, "error": error, "errorKind": kind, "raw": raw[:MAX_RAW_CAPTURE]})
    sys.exit(0)


def import_serial():
    try:
        import serial  # noqa: F401  (imported for availability check)

        return serial
    except ImportError:
        fail(
            "pyserial is not installed. Install it with: pip install -r requirements.txt",
            ERR_NO_TRANSPORT,
        )


def open_port(serial_mod, port, baud, read_timeout_s, reset_target):
    """Open the serial port.

    DTR/RTS are deasserted before opening unless --reset-target is given: on the
    common CP2102/CH340 auto-reset wiring, asserting them reboots the board and
    would destroy the very runtime state we are trying to observe.
    """
    try:
        handle = serial_mod.Serial()
        handle.port = port
        handle.baudrate = baud
        handle.timeout = read_timeout_s
        handle.write_timeout = read_timeout_s
        if not reset_target:
            handle.dtr = False
            handle.rts = False
        handle.open()
        return handle
    except Exception as exc:  # pyserial raises SerialException and OSError variants
        fail("Could not open port %s: %s" % (port, exc), ERR_PORT_UNAVAILABLE)


def exchange(handle, request_obj, deadline):
    """Send one request and read lines until the matching response or the deadline."""
    request_id = int(time.time() * 1000) % 1000000
    request_obj["id"] = request_id

    line = json.dumps(request_obj, separators=(",", ":")) + "\n"

    try:
        handle.reset_input_buffer()
    except Exception:
        pass  # Not fatal — stale bytes are tolerated by the id match below.

    try:
        handle.write(line.encode("utf-8"))
        handle.flush()
    except Exception as exc:
        fail("Failed to write request: %s" % exc, ERR_PORT_UNAVAILABLE)

    collected = []
    while time.time() < deadline:
        try:
            raw_line = handle.readline()
        except Exception as exc:
            fail("Serial read failed: %s" % exc, ERR_PORT_UNAVAILABLE, "".join(collected))

        if not raw_line:
            continue

        text = raw_line.decode("utf-8", errors="replace").strip()
        if not text:
            continue

        collected.append(text + "\n")

        if not text.startswith("{"):
            # Ordinary firmware logging interleaved with agent replies — keep it
            # in the raw capture but do not treat it as a response.
            continue

        try:
            parsed = json.loads(text)
        except ValueError:
            continue

        if parsed.get("id") not in (request_id, None):
            continue  # Response to some earlier request; keep waiting.

        if parsed.get("ok") is True:
            return {"ok": True, "data": parsed.get("data"), "raw": text}

        return {
            "ok": False,
            "error": parsed.get("error", "Agent reported an error"),
            "errorKind": parsed.get("errorKind", ERR_INTERNAL),
            "raw": text,
        }

    raw = "".join(collected)
    kind = ERR_AGENT_NOT_PRESENT if not raw.strip() else ERR_TIMEOUT
    detail = (
        "No response from the interrogation agent. Confirm the agent firmware is "
        "flashed and that nothing else holds the port."
        if kind == ERR_AGENT_NOT_PRESENT
        else "Timed out waiting for a matching agent response."
    )
    return {"ok": False, "error": detail, "errorKind": kind, "raw": raw}


def main():
    parser = argparse.ArgumentParser(description="ESP32 interrogation agent serial bridge")
    parser.add_argument("--port", help="Serial port (e.g. /dev/ttyUSB0, COM3)")
    parser.add_argument("--baud", type=int, default=115200, help="Baud rate (default: 115200)")
    parser.add_argument(
        "--timeout",
        type=int,
        default=8000,
        help="Response timeout in milliseconds (default: 8000)",
    )
    parser.add_argument("--request", help="Request JSON: {\"op\": \"...\", \"params\": {...}}")
    parser.add_argument(
        "--reset-target",
        action="store_true",
        help="Assert DTR/RTS on open, rebooting boards with auto-reset wiring (off by default)",
    )
    parser.add_argument(
        "--check",
        action="store_true",
        help="Report whether pyserial is available without opening a port",
    )
    args = parser.parse_args()

    if args.check:
        try:
            import serial

            emit({"ok": True, "data": {"pyserial": getattr(serial, "__version__", "unknown")}, "raw": ""})
        except ImportError:
            fail("pyserial is not installed", ERR_NO_TRANSPORT)
        return

    if not args.port:
        fail("--port is required", ERR_NO_TRANSPORT)
    if not args.request:
        fail("--request is required", ERR_INTERNAL)

    try:
        request_obj = json.loads(args.request)
    except ValueError as exc:
        fail("Invalid --request JSON: %s" % exc, ERR_MALFORMED)

    if not isinstance(request_obj, dict) or "op" not in request_obj:
        fail("--request must be a JSON object containing an 'op' field", ERR_MALFORMED)

    request_obj.setdefault("params", {})

    serial_mod = import_serial()
    timeout_s = max(args.timeout, 100) / 1000.0
    # Poll in short slices so the overall deadline stays responsive.
    handle = open_port(serial_mod, args.port, args.baud, min(0.5, timeout_s), args.reset_target)

    try:
        result = exchange(handle, request_obj, time.time() + timeout_s)
    finally:
        try:
            handle.close()
        except Exception:
            pass

    result["raw"] = result.get("raw", "")[:MAX_RAW_CAPTURE]
    emit(result)


if __name__ == "__main__":
    main()
