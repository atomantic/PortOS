"""Playback-reference framing and speech-detector regressions for the realtime voice sidecar (#20512), without model weights.

The detector cases run the frames through FrameFeeder (the sidecar's own framing) into a speech detector. In CI that is
ModelDetector, which follows the far-end rule of Sophon's Session.feed (mac/engine.py: threshold max(0.012, 3.5 x noise,
k x the loudest of the last ten far frames), k = 0.5 for the first 3 s of playback then 0.12, onset after 100 ms above it).
When a Sophon Mac install is present (PORTOS_SOPHON_ENGINE = path to its engine.py, or ~/.portos/sophon-mac/app/engine.py),
the same cases also run against the installed engine's real Session, with its MLX imports stubbed out.

The audio is synthetic: a tone at a set RMS stands in for residual echo or near-end speech. Room acoustics are not modelled.
"""
import collections, importlib.util, os, sys, time, types, unittest
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from portos_sophon_frames import FRAME, FrameFeeder  # noqa: E402

SR = 16000


def tone(rms, n=FRAME, freq=220.0, start=0):
    t = (np.arange(n) + start) / SR
    return (np.sin(2 * np.pi * freq * t) * rms * np.sqrt(2)).astype(np.float32)


def to_pcm16(x):
    return (np.clip(x, -1, 1) * 32767).astype("<i2").tobytes()


def message(mic, far=None):
    """One wire message as the PortOS server sends it: mic bytes, or mic bytes followed by reference bytes."""
    return to_pcm16(mic) + (to_pcm16(far) if far is not None else b"")


class ModelDetector:
    """The far-end part of Sophon's Session.feed and its barge-in on onset (see the module docstring)."""

    def __init__(self):
        self.far_hist = collections.deque([0.0] * 10, maxlen=10); self.played_s = 0.0; self.noise = 0.003
        self.voiced = 0; self.speech_ms = 0; self.reply = None; self.played = []

    def play(self, x):
        self.played.append(x)

    def feed(self, f, far=None):
        r = float(np.sqrt(np.mean(np.square(f))))
        if far is not None:
            fr = float(np.sqrt(np.mean(np.square(far)))); self.far_hist.append(fr)
            if fr > 1e-3: self.played_s += 0.02
        k = 0.5 if self.played_s < 3.0 else 0.12
        thr = max(0.012, self.noise * 3.5, k * max(self.far_hist))
        if self.speech_ms: return
        if r > thr:
            self.voiced += 20
            if self.voiced >= 100: self._onset()
        else:
            self.voiced = 0; self.noise = 0.98 * self.noise + 0.02 * min(r, 0.05)

    def _onset(self):
        if self.reply is not None and not self.reply["cancel"]:
            self.reply["cancel"] = True; self.play(None)
        self.speech_ms = self.voiced


def _stub_mlx():
    """Stand-ins for the MLX packages engine.py imports at module level that are not installed; Session.feed never calls them."""
    names = {
        "mlx": {}, "mlx.core": {}, "mlx_lm": {"load": None, "stream_generate": None}, "mlx_lm.models": {},
        "mlx_lm.models.cache": {"make_prompt_cache": None, "trim_prompt_cache": None}, "mlx_lm.sample_utils": {"make_sampler": None},
        "mlx_audio": {}, "mlx_audio.tts": {}, "mlx_audio.tts.utils": {"load_model": None}, "mlx_ear": {"load_ear": None, "embed_audio": None},
    }
    for name, attrs in names.items():
        try:
            importlib.import_module(name); continue                  # a real install wins
        except ImportError:
            pass
        mod = types.ModuleType(name); mod.__dict__.update(attrs); sys.modules[name] = mod
        parent, _, child = name.rpartition(".")
        if parent: setattr(sys.modules[parent], child, mod)


def _engine_path():
    explicit = os.environ.get("PORTOS_SOPHON_ENGINE")
    if explicit: return Path(explicit)
    default = Path.home() / ".portos" / "sophon-mac" / "app" / "engine.py"
    return default if default.exists() else None


def _load_engine(path):
    _stub_mlx()
    spec = importlib.util.spec_from_file_location("sophon_engine_under_test", path)
    mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
    return mod


class EngineDetector:
    """The installed Sophon Session, driven only through feed()."""

    def __init__(self, engine):
        self.played = []
        self.sess = engine.Session(None, self.played.append, log=lambda _line: None)

    @property
    def reply(self): return self.sess.reply

    @reply.setter
    def reply(self, r): self.sess.reply = r

    def feed(self, f, far=None): self.sess.feed(f, far)

    @property
    def speech_ms(self): return self.sess.speech_ms


def active_reply():
    """A reply that started speaking a second ago and is still generating: an onset now is a barge-in that cuts it."""
    return {"user": None, "ukey": None, "cancel": False, "done": False, "gen_s": 5.0, "t_sil": time.time() - 2, "t_out": time.time() - 1.0,
            "sgen": 0, "text": "Here is a longer reply that is still playing."}


class FrameFeederTest(unittest.TestCase):
    def test_reference_messages_split_into_aligned_frame_pairs(self):
        calls = []
        feeder = FrameFeeder(lambda f, far=None: calls.append((f, far)))
        feeder.set_reference(True)
        mic, far = tone(0.1, 500), tone(0.3, 500, freq=440)
        feeder.push(message(mic[:200], far[:200]))
        self.assertEqual(calls, [])
        feeder.push(message(mic[200:], far[200:]))
        self.assertEqual(len(calls), 1)
        f, r = calls[0]
        self.assertEqual((len(f), len(r)), (FRAME, FRAME))
        np.testing.assert_allclose(f, mic[:FRAME], atol=1e-4)
        np.testing.assert_allclose(r, far[:FRAME], atol=1e-4)

    def test_microphone_only_frames_are_fed_without_a_reference(self):
        calls = []
        feeder = FrameFeeder(lambda f, *far: calls.append(far))
        feeder.push(message(tone(0.1, FRAME * 2)))
        self.assertEqual(calls, [(), ()])

    def test_a_dropped_reference_feeds_silence_so_stale_playback_drains(self):
        calls = []
        feeder = FrameFeeder(lambda f, far=None: calls.append(far))
        feeder.push(message(tone(0.1, 100)))                         # buffered before the reference starts
        feeder.set_reference(True)
        feeder.push(message(tone(0.1, FRAME), tone(0.3, FRAME)))
        feeder.set_reference(False)
        feeder.push(message(tone(0.1, FRAME)))
        self.assertEqual(len(calls), 2)
        self.assertTrue(np.all(calls[0][:100] == 0))                 # the pre-reference samples had no playback
        self.assertGreater(float(np.abs(calls[0][100:]).max()), 0.3)
        self.assertTrue(np.all(calls[1][100:] == 0))                 # mic-only audio after the reference stopped


class DetectorRegression:
    """Echo alone does not cancel a reply; near-end speech still does. Subclasses pick the detector."""

    def make(self): raise NotImplementedError

    def run_frames(self, det, mic_rms, far_rms, frames=15, reference=True):
        feeder = FrameFeeder(det.feed)
        feeder.set_reference(reference)
        for i in range(frames):
            mic = tone(mic_rms, start=i * FRAME)
            far = tone(far_rms, freq=330.0, start=i * FRAME) if far_rms else np.zeros(FRAME, np.float32)
            feeder.push(message(mic, far if reference else None))

    def test_residual_echo_with_aligned_playback_does_not_cancel_the_reply(self):
        det = self.make(); det.reply = active_reply()
        self.run_frames(det, mic_rms=0.02, far_rms=0.30)
        self.assertFalse(det.reply["cancel"]); self.assertEqual(det.played, [])

    def test_the_same_echo_without_a_reference_cancels_it(self):
        det = self.make(); det.reply = active_reply()
        self.run_frames(det, mic_rms=0.02, far_rms=0.30, reference=False)
        self.assertTrue(det.reply["cancel"]); self.assertEqual(det.played, [None])

    def test_near_end_speech_over_playback_still_cancels_the_reply(self):
        det = self.make(); det.reply = active_reply()
        self.run_frames(det, mic_rms=0.20, far_rms=0.30)
        self.assertTrue(det.reply["cancel"]); self.assertEqual(det.played, [None])

    def test_muted_output_leaves_normal_sensitivity(self):
        # Muted playback renders silence, so the post-volume reference is silent and quiet speech still barges in.
        det = self.make(); det.reply = active_reply()
        self.run_frames(det, mic_rms=0.05, far_rms=0.0)
        self.assertTrue(det.reply["cancel"])

    def test_quiet_input_does_not_trigger_without_a_reference(self):
        det = self.make(); det.reply = active_reply()
        self.run_frames(det, mic_rms=0.005, far_rms=0.0, reference=False)
        self.assertFalse(det.reply["cancel"])


class ModelDetectorTest(DetectorRegression, unittest.TestCase):
    def make(self): return ModelDetector()


ENGINE = _engine_path()


@unittest.skipUnless(ENGINE and ENGINE.exists(), "no Sophon Mac engine installed (set PORTOS_SOPHON_ENGINE)")
class InstalledEngineTest(DetectorRegression, unittest.TestCase):
    engine = None

    @classmethod
    def setUpClass(cls):
        cls.engine = _load_engine(ENGINE)

    def make(self): return EngineDetector(self.engine)


if __name__ == "__main__":
    unittest.main()
