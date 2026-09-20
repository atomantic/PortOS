"""Runner contract tests without model weights or a torch installation."""
import contextlib
import importlib
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))


class Qwen21Pipeline:
    # Deliberately matches the upstream boundary: no guidance_scale/strength.
    def __call__(self, prompt, height, width, num_inference_steps, generator,
                 true_cfg_scale=1.0, image=None):
        self.received = dict(prompt=prompt, steps=num_inference_steps,
                             cfg=true_cfg_scale, image=image)
        return SimpleNamespace(images=[Image.new('RGBA', (32, 32), (10, 20, 30, 64))])


class RunnerContract(unittest.TestCase):
    def test_qwen21_generation_and_edit_preserve_alpha(self):
        torch = SimpleNamespace(
            bfloat16='bf16', float32='fp32', inference_mode=contextlib.nullcontext,
            backends=SimpleNamespace(mps=SimpleNamespace(is_available=lambda: False)),
            cuda=SimpleNamespace(is_available=lambda: False),
        )
        with patch.dict(sys.modules, {'torch': torch}):
            runner = importlib.import_module('z_image_turbo')
        for editing in (False, True):
            with self.subTest(editing=editing), tempfile.TemporaryDirectory() as directory:
                source = Path(directory) / 'source.png'
                output = Path(directory) / 'output.png'
                Image.new('RGBA', (48, 64), (1, 2, 3, 50)).save(source)
                argv = ['runner', '--model', 'qwen-image-2.1', '--repo', 'Qwen/Qwen-Image-2.1',
                        '--pipeline-class', 'QwenImage21Pipeline', '--prompt', 'A transparent icon',
                        '--steps', '40', '--guidance', '1', '--seed', '42', '--output', str(output)]
                if editing:
                    argv += ['--image-path', str(source), '--image-strength', '0.5']
                pipe = Qwen21Pipeline()
                with patch.object(sys, 'argv', argv), patch.multiple(
                    runner, pick_device=lambda _: 'cpu',
                    load_pipeline=lambda *a, **kw: (pipe, 'cpu'),
                    emit_image_execution_marker=lambda *a: None,
                    apply_memory_optimizations=lambda *a, **kw: None,
                    apply_loras=lambda *a: None,
                    make_generator=lambda *a: 'generator',
                    make_stepwise_callback=lambda *a, **kw: None,
                    set_vae_tiling=lambda *a: None,
                    to_i2i_pipeline=lambda _: self.fail('Unified pipeline must not be converted'),
                ):
                    runner.main()
                self.assertEqual(pipe.received['steps'], 40)
                self.assertEqual(pipe.received['cfg'], 1)
                if editing:
                    self.assertEqual(pipe.received['image'].size, (48, 64))
                    self.assertEqual(pipe.received['image'].getpixel((0, 0))[3], 50)
                else:
                    self.assertIsNone(pipe.received['image'])
                with Image.open(output) as result:
                    self.assertEqual(result.mode, 'RGBA')
                    self.assertEqual(result.getpixel((0, 0))[3], 64)


if __name__ == '__main__':
    unittest.main()
