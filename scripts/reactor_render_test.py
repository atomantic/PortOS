"""Offline Reactor capture boundary tests; no SDK, network, or encoder required."""
import asyncio
import importlib.util
import io
import json
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch


def load_runner():
    spec = importlib.util.spec_from_file_location("reactor_render_test_target", Path(__file__).with_name("reactor-render.py"))
    module = importlib.util.module_from_spec(spec)
    with patch.dict(sys.modules, {"reactor_sdk": SimpleNamespace(Reactor=None)}):
        spec.loader.exec_module(module)
    return module


class FakeReactor:
    def __init__(self, complete=True):
        self.commands = []
        self.callbacks = {}
        self.tracks = self
        self.skipped = set(range(2, 138, 5))
        self.delivered = [index for index in range(144) if index not in self.skipped]
        if not complete:
            self.delivered.pop()  # 115/144 is just below the 80% admission threshold.
        self.disconnected = False

    def on(self, kind, callback):
        self.message = callback

    async def connect(self):
        pass

    async def disconnect(self):
        self.disconnected = True

    def with_direction(self, direction):
        return self

    def with_kind(self, kind):
        self.kind = kind
        return self

    def one(self):
        return self

    def on_raw_frame(self, callback):
        self.callbacks[self.kind] = callback

    def frame(self, index):
        # Nonzero PTS origin, and integer microseconds like the decoded SDK track.
        timestamp = 9_000_000 + int(index * 1_000_000 / 24)
        self.callbacks["video"](bytes([index]) * 16, 2, 2, index, timestamp, None)

    async def send_command(self, name, data):
        self.commands.append((name, data))
        if name == "enqueue":
            self.frame(255)  # Idle preview must not become a paid clip frame.
            self.message({"type": "clip_generated"})
            return {"data": {"clip": {"clip_id": "example-clip", "frames": 144.0, "seconds": 6}}}
        if name == "play":
            self.frame(0)  # Track delivery may precede the clip_started message.
            self.message({"type": "clip_started"})
            self.frame(1)
            self.callbacks["audio"](b"\x01\x00" * 144000, 144000, 24000, 1)
            self.message({"type": "clip_finished"})
        return {}

    async def drain(self, delay):
        for index in self.delivered[2:]:
            self.frame(index)  # Decoder output can trail clip_finished.


class CaptureLifecycleTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.runner = load_runner()
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.output = Path(self.temp.name) / "render.mp4"
        self.params = {"prompt": "A paper boat drifts.", "seconds": 6, "jwt": "example-token", "outputPath": str(self.output)}

    async def run_capture(self, reactor, spawn):
        log = io.StringIO()
        with patch.object(self.runner, "Reactor", return_value=reactor), \
                patch.object(self.runner.asyncio, "sleep", reactor.drain), \
                patch.object(self.runner.asyncio, "create_subprocess_exec", spawn), redirect_stdout(log):
            await self.runner.render(self.params)
        return [json.loads(line) for line in log.getvalue().splitlines()]

    async def test_timestamp_gaps_hold_previous_frame_without_shortening_video_or_audio(self):
        reactor = FakeReactor()

        async def encode(*command, **kwargs):
            video = Path(command[command.index("-i") + 1]).read_bytes()
            expected = [index - 1 if index in reactor.skipped else index for index in range(144)]
            self.assertEqual(video, b"".join(bytes([index]) * 16 for index in expected))
            self.assertEqual(Path(str(self.output) + ".capture/audio.pcm").read_bytes(), b"\x01\x00" * 144000)
            self.assertEqual(command[command.index("-t") + 1], "6.0")
            self.assertEqual(command[command.index("-framerate") + 1], "24")
            capture = json.loads(Path(str(self.output) + ".capture/capture.json").read_text())
            self.assertEqual(capture["frames"], 116)
            self.assertEqual(capture["expected"], 144)
            self.output.write_bytes(b"example-mp4")
            return SimpleNamespace(returncode=0, wait=AsyncMock(return_value=0))

        spawn = AsyncMock(side_effect=encode)
        events = await self.run_capture(reactor, spawn)
        self.assertEqual([name for name, _ in reactor.commands], ["set_canvas", "enqueue", "play"])
        self.assertEqual(events[-1], {"type": "complete", "clipId": "example-clip", "seconds": 6.0})
        self.assertTrue(reactor.disconnected)
        self.assertFalse(Path(str(self.output) + ".capture").exists())
        spawn.assert_awaited_once()

    async def test_capture_just_below_eighty_percent_disconnects_without_encoding_or_retrying(self):
        reactor = FakeReactor(complete=False)
        spawn = AsyncMock()
        with self.assertRaisesRegex(RuntimeError, "115 of 144"):
            await self.run_capture(reactor, spawn)
        self.assertTrue(reactor.disconnected)
        self.assertEqual(sum(name == "enqueue" for name, _ in reactor.commands), 1)
        spawn.assert_not_awaited()
        self.assertTrue(Path(str(self.output) + ".capture/video.bgra").is_file())

    async def test_cancelled_encoder_is_terminated_then_killed_and_reaped(self):
        reactor = FakeReactor()
        encoder = SimpleNamespace(returncode=None)
        encoder.wait = AsyncMock(side_effect=[asyncio.CancelledError(), asyncio.TimeoutError(), -9])
        encoder.terminate = unittest.mock.Mock()
        encoder.kill = unittest.mock.Mock()
        with self.assertRaises(asyncio.CancelledError):
            await self.run_capture(reactor, AsyncMock(return_value=encoder))
        encoder.terminate.assert_called_once()
        encoder.kill.assert_called_once()
        self.assertEqual(encoder.wait.await_count, 3)
        self.assertTrue(reactor.disconnected)

    async def test_invalid_request_never_constructs_a_session(self):
        with patch.object(self.runner, "Reactor") as factory:
            for change in ({"prompt": ""}, {"seconds": float("nan")}, {"sourceImagePath": str(Path(self.temp.name) / "missing.png")}):
                with self.subTest(change=change), self.assertRaises(ValueError):
                    await self.runner.render({**self.params, **change})
            factory.assert_not_called()


if __name__ == "__main__":
    unittest.main()
