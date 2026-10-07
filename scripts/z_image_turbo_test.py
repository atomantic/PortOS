"""Runner contract tests without model weights or a torch installation."""
import contextlib
import importlib
import io
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


class FakeReduction:
    def __init__(self, value):
        self.value = value

    def all(self):
        return self

    def item(self):
        return self.value


class FakeTensor:
    def __init__(self, *, finite=True, dtype='fp32'):
        self.finite = finite
        self.dtype = dtype
        self.device = 'mps'

    def to(self, *args, device=None, dtype=None):
        if args:
            self.device = args[0]
        if device is not None:
            self.device = device
        if dtype is not None:
            self.dtype = dtype
        return self

    def view(self, *_shape):
        return self

    def __mul__(self, _other):
        return self

    def __add__(self, _other):
        return self

    def __getitem__(self, _key):
        return self


class FakeVae:
    def __init__(self, outcomes):
        self.config = SimpleNamespace(latents_mean=[0.0], latents_std=[1.0], z_dim=1)
        self.dtype = 'fp32'
        self.outcomes = list(outcomes)
        self.decode_dtypes = []

    def to(self, *, dtype):
        self.dtype = dtype
        return self

    def decode(self, _latents, return_dict=False):
        self.decode_dtypes.append(self.dtype)
        return (FakeTensor(finite=self.outcomes.pop(0), dtype=self.dtype),)


class FakeQwenDecodePipeline:
    vae_scale_factor = 8

    def __init__(self, outcomes):
        self.vae = FakeVae(outcomes)
        self.image_processor = SimpleNamespace(postprocess=lambda decoded, output_type: [('image', decoded, output_type)])

    def _unpack_latents(self, _latents, _height, _width, _scale_factor):
        return FakeTensor(dtype='bf16')


class RunnerContract(unittest.TestCase):
    def test_missing_pipeline_reports_runtime_remedy_before_exit_two(self):
        with patch.dict(sys.modules, {'torch': SimpleNamespace()}):
            runner = importlib.import_module('z_image_turbo')
        stderr = io.StringIO()
        with patch.dict(sys.modules, {'diffusers': SimpleNamespace()}), patch.multiple(
            runner, suppress_cosmetic_clip_truncation=lambda: None,
            heartbeat=lambda _: contextlib.nullcontext(),
        ), contextlib.redirect_stderr(stderr), self.assertRaises(SystemExit) as stopped:
            runner.load_pipeline('Qwen/Qwen-Image-2.1', 'cpu', 'bf16', 'QwenImage21Pipeline')
        self.assertEqual(stopped.exception.code, 2)
        self.assertIn('USER_ERROR:torch_runtime_broken', stderr.getvalue())
        self.assertIn('QwenImage21Pipeline', stderr.getvalue())
        self.assertIn('FLUX2_FORCE_REINSTALL=1', stderr.getvalue())

    def test_qwen21_reference_images_encode_in_the_vae_dtype(self):
        with patch.dict(sys.modules, {'torch': SimpleNamespace()}):
            runner = importlib.import_module('z_image_turbo')
        seen = []

        class Tensor:
            def __init__(self, dtype):
                self.dtype = dtype

            def to(self, *, dtype):
                return Tensor(dtype)

        def encode(image, _generator):
            seen.append(image.dtype)
            return Tensor(image.dtype)

        pipe = SimpleNamespace(vae=SimpleNamespace(dtype='fp32'), _encode_vae_image=encode)
        runner.encode_references_in_vae_dtype(pipe)
        latents = pipe._encode_vae_image(Tensor('bf16'), None)
        self.assertEqual(seen, ['fp32'])
        self.assertEqual(latents.dtype, 'bf16')

    def test_qwen21_decode_guard_accepts_finite_output_and_retries_once(self):
        torch = SimpleNamespace(
            float32='fp32',
            tensor=lambda _values: FakeTensor(),
            isfinite=lambda tensor: FakeReduction(tensor.finite),
        )
        with patch.dict(sys.modules, {'torch': torch}):
            runner = importlib.import_module('z_image_turbo')
        for outcomes, expected_calls, expect_retry_log in (
            ([True], ['fp32'], False),
            ([False, True], ['fp32', 'fp32'], True),
        ):
            with self.subTest(outcomes=outcomes), contextlib.redirect_stderr(io.StringIO()) as stderr:
                pipe = FakeQwenDecodePipeline(outcomes)
                images = runner.decode_qwen21_latents(pipe, FakeTensor(), 1216, 832)
                self.assertEqual(images[0][0], 'image')
                self.assertEqual(images[0][2], 'pil')
                self.assertEqual(pipe.vae.decode_dtypes, expected_calls)
                self.assertEqual('recovered after a float32 retry' in stderr.getvalue(), expect_retry_log)

    def test_qwen21_decode_guard_fails_before_writing_non_finite_output(self):
        torch = SimpleNamespace(
            float32='fp32',
            tensor=lambda _values: FakeTensor(),
            isfinite=lambda tensor: FakeReduction(tensor.finite),
        )
        with patch.dict(sys.modules, {'torch': torch}):
            runner = importlib.import_module('z_image_turbo')
        pipe = FakeQwenDecodePipeline([False, False])
        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr), self.assertRaisesRegex(RuntimeError, 'produced NaNs'):
            runner.decode_qwen21_latents(pipe, FakeTensor(), 1216, 832)
        self.assertEqual(pipe.vae.decode_dtypes, ['fp32', 'fp32'])
        self.assertIn('USER_ERROR:qwen_mps_nan', stderr.getvalue())

    def test_qwen21_generation_and_edit_preserve_alpha(self):
        torch = SimpleNamespace(
            bfloat16='bf16', float32='fp32', inference_mode=contextlib.nullcontext,
            backends=SimpleNamespace(mps=SimpleNamespace(is_available=lambda: False)),
            cuda=SimpleNamespace(is_available=lambda: False),
        )
        with patch.dict(sys.modules, {'torch': torch}):
            runner = importlib.import_module('z_image_turbo')
        for editing, references in ((False, 0), (True, 0), (False, 10), (True, 9)):
            with self.subTest(editing=editing, references=references), tempfile.TemporaryDirectory() as directory:
                source = Path(directory) / 'source.png'
                output = Path(directory) / 'output.png'
                Image.new('RGBA', (48, 64), (1, 2, 3, 50)).save(source)
                argv = ['runner', '--model', 'qwen-image-2.1', '--repo', 'Qwen/Qwen-Image-2.1',
                        '--pipeline-class', 'QwenImage21Pipeline', '--prompt', 'A transparent icon',
                        '--steps', '40', '--guidance', '1', '--seed', '42', '--output', str(output)]
                if editing:
                    argv += ['--image-path', str(source), '--image-strength', '0.5']
                if references:
                    argv += ['--reference-images'] + [str(source)] * references
                pipe = Qwen21Pipeline()
                stderr = io.StringIO()
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
                ), contextlib.redirect_stderr(stderr):
                    runner.main()
                self.assertIn('🎨 qwen-image-2.1 generate', stderr.getvalue())
                self.assertIn(f'references={references}', stderr.getvalue())
                self.assertNotIn('🎨 z-image generate', stderr.getvalue())
                self.assertEqual(pipe.received['steps'], 40)
                self.assertEqual(pipe.received['cfg'], 1)
                if references:
                    self.assertEqual(len(pipe.received['image']), 10)
                    for image in pipe.received['image']:
                        self.assertEqual(image.size, (48, 64))
                        self.assertEqual(image.getpixel((0, 0))[3], 50)
                elif editing:
                    self.assertEqual(pipe.received['image'].size, (48, 64))
                    self.assertEqual(pipe.received['image'].getpixel((0, 0))[3], 50)
                else:
                    self.assertIsNone(pipe.received['image'])
                with Image.open(output) as result:
                    self.assertEqual(result.mode, 'RGBA')
                    self.assertEqual(result.getpixel((0, 0))[3], 64)


if __name__ == '__main__':
    unittest.main()
