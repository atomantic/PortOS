"""Offline Voice Call AvatarForcing worker: newline JSON over pipes, no listener or remote code."""

import argparse
import base64
import contextlib
import io
import json
import re
import sys
import threading
from pathlib import Path
from queue import SimpleQueue

import numpy as np
from PIL import Image

from motion import FRAMES_PER_SECOND, SAMPLE_RATE
from render import frames, prepare, read_wave

# More than enough for a short mono TTS sentence; refuse over-sized messages
# without reading an unbounded line into memory.
MAX_MESSAGE = 4 * 1024 * 1024
REQUEST_ID = re.compile(r"[A-Za-z0-9_-]{1,64}\Z")
MAX_AUDIO_SECONDS = 16


class PipeProtocol:
    def __init__(self, incoming, outgoing):
        self.incoming = incoming
        self.outgoing = outgoing
        self.pending = SimpleQueue()
        self.lock = threading.Lock()
        self.active = None
        self.closed = False

    def send(self, kind, **fields):
        with self.lock:
            try:
                self.outgoing.write(json.dumps({"type": kind, **fields}, separators=(",", ":")) + "\n")
                self.outgoing.flush()
            except BrokenPipeError:
                self.closed = True
                if self.active is not None:
                    self.active[1].set()

    def finish(self, request, cancelled):
        with self.lock:
            self.active = None
        self.send("cancelled" if cancelled else "done", id=request)

    def read(self):
        try:
            while line := self.incoming.readline(MAX_MESSAGE + 1):
                if len(line) > MAX_MESSAGE or not line.endswith(b"\n"):
                    self.send("error", message="Oversized or incomplete message")
                    return
                try:
                    item = json.loads(line)
                    if not isinstance(item, dict):
                        raise ValueError
                    request = item.get("id")
                    if not isinstance(request, str) or not REQUEST_ID.fullmatch(request):
                        raise ValueError
                except (ValueError, TypeError):
                    self.send("error", message="Invalid request")
                    continue
                if item.get("type") == "cancel":
                    with self.lock:
                        if self.active is not None and self.active[0] == request:
                            self.active[1].set()
                    continue
                if item.get("type") != "speak" or not isinstance(item.get("wav"), str):
                    self.send("error", id=request, message="Expected a speak or cancel request")
                    continue
                with self.lock:
                    busy = self.active is not None
                    if not busy:
                        stopped = threading.Event()
                        self.active = (request, stopped)
                if busy:
                    self.send("error", id=request, message="Avatar renderer is busy")
                else:
                    self.pending.put((request, stopped, item["wav"]))
        finally:
            with self.lock:
                self.closed = True
                if self.active is not None:
                    self.active[1].set()
            self.pending.put(None)


def encode_jpeg(frame):
    output = io.BytesIO()
    Image.fromarray(frame).save(output, format="JPEG", quality=78, optimize=False)
    return base64.b64encode(output.getvalue()).decode("ascii")


def output_request(protocol, request, stopped, data, prepared, args):
    try:
        wav = read_wave(io.BytesIO(base64.b64decode(data, validate=True)), MAX_AUDIO_SECONDS)
        seq = 0
        for group in frames(prepared, wav, args, stopped.is_set):
            for frame in group:
                if stopped.is_set():
                    break
                jpg = encode_jpeg(frame)
                if stopped.is_set():
                    break
                protocol.send("frame", id=request, index=seq, timeMs=seq * 1000 // FRAMES_PER_SECOND, jpeg=jpg)
                seq += 1
        protocol.finish(request, stopped.is_set())
    except (ValueError, RuntimeError, OSError) as error:
        print(f"Avatar request failed: {error}", file=sys.stderr, flush=True)
        with protocol.lock:
            protocol.active = None
        protocol.send("error", id=request, message="Avatar frame generation failed")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("weights", type=Path)
    parser.add_argument("portrait", type=Path)
    args = parser.parse_args()
    args.device, args.half, args.steps, args.seed, args.frame_batch = "mps", True, 8, 66, 4
    # Native library diagnostics must never enter the line protocol.
    protocol = PipeProtocol(sys.stdin.buffer, sys.stdout)
    with contextlib.redirect_stdout(sys.stderr):
        prepared = prepare(args)
        # Warm the graphics and speech graphs with synthetic silence before
        # advertising the worker as ready.
        warmup = np.zeros(SAMPLE_RATE * 2, dtype=np.float32)
        for _ in frames(prepared, warmup, args):
            pass
        protocol.send("ready", fps=FRAMES_PER_SECOND, limitSeconds=MAX_AUDIO_SECONDS)
        reader = threading.Thread(target=protocol.read, daemon=True)
        reader.start()
        while request := protocol.pending.get():
            output_request(protocol, *request, prepared, args)
        reader.join()


if __name__ == "__main__":
    main()
