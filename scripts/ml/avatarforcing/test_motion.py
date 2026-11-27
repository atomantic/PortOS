"""Regression for the attention convention that determines audio alignment."""

import unittest

try:
    import torch
    from motion import inference_masks
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
