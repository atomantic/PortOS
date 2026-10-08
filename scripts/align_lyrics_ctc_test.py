"""Dependency-free checks of the production CTC transcript/timebase boundary."""
import unittest
from types import SimpleNamespace
from align_lyrics_ctc import targets_for_lines, word_times, emissions_for_audio, HOP, RECEPTIVE_FIELD


class Tensor:
    def __init__(self, start, frames):
        self.start, self.frames = start, frames
        self.shape = (1, frames)

    def __getitem__(self, key):
        crop = key[1]
        return Tensor(self.start + crop.start, crop.stop - crop.start)

    def to(self, device):
        return self

    def cpu(self):
        return self


class CtcContract(unittest.TestCase):
    def test_garbage_and_slots_preserve_punctuation_accents_repeated_letters_and_occurrences(self):
        dictionary = {char: i for i, char in enumerate('-*abcdefghijklmnopqrstuvwxyz')}
        lines = [['Hello,', 'café!'], ['Hello,'], []]
        targets, slots = targets_for_lines(lines, dictionary)
        self.assertEqual([i for i, token in enumerate(targets) if token == dictionary['*']], [0, 10, 16])
        self.assertEqual([word for _, _, word in slots], ['Hello,', 'café!', 'Hello,'])
        spans = [SimpleNamespace(start=i * 3, end=i * 3 + 2) for i in range(len(targets))]
        result = word_times(lines, slots, spans, 0.02)
        self.assertEqual(result[0][0], {'w': 'Hello,', 'startSec': 0.06, 'endSec': 0.34})
        self.assertEqual(result[1][0]['startSec'], 0.66)
        self.assertEqual(result[2], [])
        with self.assertRaises(ValueError):
            targets_for_lines([['123']], dictionary)

    def test_emission_chunks_keep_every_global_frame_once_across_context_seams(self):
        frames = 2055
        waveform = Tensor(0, (frames - 1) * HOP + RECEPTIVE_FIELD)
        def model(crop):
            self.assertEqual(crop.start % HOP, 0)
            return Tensor(crop.start // HOP, (crop.frames - RECEPTIVE_FIELD) // HOP + 1), None
        class Torch:
            @staticmethod
            def cat(chunks, dim):
                return [chunk.start + i for chunk in chunks for i in range(chunk.frames)]
        self.assertEqual(emissions_for_audio(model, waveform, Torch, 'cpu'), list(range(frames)))


if __name__ == '__main__':
    unittest.main()
