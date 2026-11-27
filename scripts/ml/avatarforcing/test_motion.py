"""Regression for the attention convention that determines audio alignment."""

import io
import json
import unittest
from unittest.mock import patch

try:
    import torch
    from motion import BLOCK, CLEAN, IDLE_STAGE_PARAMS, WINDOW, idle_blocks, inference_masks, sample, tail_context
except ImportError:
    torch = None


@unittest.skipIf(torch is None, "PyTorch is not installed")
class InferenceMaskTest(unittest.TestCase):
    def test_audio_attention_can_only_look_two_frames_left_or_right(self):
        _, audio = inference_masks("cpu")
        self.assertEqual(audio[20].nonzero().flatten().tolist(), [18, 19, 20, 21, 22])
        self.assertEqual(audio[0].nonzero().flatten().tolist(), [0, 1, 2])
        self.assertEqual(int(audio.sum()), 244)

    def test_motion_uses_previous_blocks_and_limited_lookahead(self):
        motion, _ = inference_masks("cpu")
        self.assertEqual(motion[12].nonzero().flatten().tolist(), list(range(15)))
        self.assertTrue(bool(motion.diagonal().all()))
        self.assertFalse(bool(motion[0, 49]))
        self.assertEqual(int(motion.sum()), 1372)

    def test_tail_context_extracts_exact_clean_suffix(self):
        motion = torch.arange(WINDOW, dtype=torch.float32)[None, :, None].expand(1, WINDOW, 512)
        audio = motion * 10
        m_tail, a_tail = tail_context(motion, audio, CLEAN + 5)
        self.assertEqual(tuple(m_tail.shape), (1, CLEAN, 512))
        self.assertEqual(int(m_tail[0, 0, 0]), 5)
        self.assertEqual(int(m_tail[0, -1, 0]), CLEAN + 4)
        self.assertEqual(int(a_tail[0, -1, 0]), (CLEAN + 4) * 10)

        short_m, short_a = tail_context(motion, audio, 12)
        self.assertEqual(tuple(short_m.shape), (1, CLEAN, 512))
        self.assertEqual(int(short_m[0, 0, 0]), 0)
        self.assertEqual(int(short_m[0, -1, 0]), 11)
        self.assertEqual(int(short_a[0, -1, 0]), 110)

    def test_sample_with_warm_state_preserves_frame_count_and_alignment(self):
        seen_windows = []

        def fake_denoise(weights, audio_window, ref, phase, timeline, generator, clean, history_tail, **_kw):
            seen_windows.append((clean, audio_window.clone()))
            return audio_window.clone()

        prior_motion = torch.full((1, CLEAN, 512), -1.0)
        prior_audio = torch.full((1, CLEAN, 512), -2.0)
        speech_audio = torch.arange(25, dtype=torch.float32)[None, :, None].expand(1, 25, 512)
        saved = []
        with patch("motion.denoise_window", side_effect=fake_denoise):
            blocks = list(sample({}, speech_audio, torch.zeros((1, 512)), steps=2,
                                 state=(prior_motion, prior_audio), on_state=saved.append))

        self.assertEqual([b.shape[1] for b in blocks], [BLOCK, BLOCK, 5])
        self.assertEqual(sum(b.shape[1] for b in blocks), 25)
        # First block must keep prior audio in positions 0..39 and align speech frame 0 at position 40.
        first_clean, first_window = seen_windows[0]
        self.assertEqual(first_clean, CLEAN)
        self.assertEqual(float(first_window[0, CLEAN - 1, 0]), -2.0)
        self.assertEqual(float(first_window[0, CLEAN, 0]), 0.0)
        self.assertEqual(float(first_window[0, WINDOW - 1, 0]), 9.0)
        # Final saved context must end cleanly on frame 24 (the exact last yielded frame).
        final_motion, final_audio = saved[-1]
        self.assertEqual(tuple(final_motion.shape), (1, CLEAN, 512))
        self.assertEqual(float(final_audio[0, -1, 0]), 24.0)

    def test_idle_blocks_transitions_from_speech_context_and_honors_cancel(self):
        calls = []

        def fake_denoise(weights, audio_window, ref, phase, timeline, generator, clean, history_tail,
                         guidance=2.0, noise_scale=1.0, cond=None, **_kw):
            calls.append((guidance, noise_scale, cond is not None))
            return audio_window.clone()

        silence = torch.zeros((1, WINDOW, 512))
        prior_state = (torch.ones((1, CLEAN, 512)), torch.full((1, CLEAN, 512), 3.0))
        with patch("motion.conditioning", return_value="cached-silence-cond"), \
             patch("motion.denoise_window", side_effect=fake_denoise):
            out = list(idle_blocks({}, silence, torch.zeros((1, 512)), stage="listening",
                                   state=prior_state, max_blocks=6))

        self.assertEqual(len(out), 6)
        self.assertTrue(all(block.shape == (1, BLOCK, 512) for block in out))
        expected_guidance, expected_noise = IDLE_STAGE_PARAMS["listening"]
        self.assertTrue(all(g == expected_guidance and n == expected_noise for g, n, _ in calls))
        # First 4 blocks transition out of prior speech tail (cond=None); blocks 4+ reuse cached silence cond.
        self.assertEqual([cached for _, _, cached in calls], [False, False, False, False, True, True])


@unittest.skipIf(torch is None, "PyTorch is not installed")
class StreamProtocolTest(unittest.TestCase):
    def test_pipe_protocol_accepts_idle_rejects_invalid_stage(self):
        from stream import PipeProtocol
        lines = "\n".join([
            json.dumps({"type": "idle", "id": "idle_1", "stage": "thinking"}),
            json.dumps({"type": "idle", "id": "idle_bad", "stage": "dancing"}),
            json.dumps({"type": "cancel", "id": "idle_1"}),
        ]) + "\n"
        outgoing = io.StringIO()
        protocol = PipeProtocol(io.BytesIO(lines.encode("utf-8")), outgoing)
        protocol.read()
        item = protocol.pending.get()
        self.assertEqual(item[0], "idle")
        self.assertEqual(item[1], "idle_1")
        self.assertTrue(item[2].is_set())
        self.assertEqual(item[3], "thinking")
        events = [json.loads(line) for line in outgoing.getvalue().splitlines() if line]
        self.assertEqual(events, [{"type": "error", "id": "idle_bad", "message": "Invalid idle stage"}])
