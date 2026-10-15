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
        self.transformer = object()
        self.text_encoder = object()
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

    def test_qwen21_reference_wrapper_skips_a_pipeline_without_the_hook(self):
        with patch.dict(sys.modules, {'torch': SimpleNamespace()}):
            runner = importlib.import_module('z_image_turbo')
        pipe = SimpleNamespace(vae=SimpleNamespace(dtype='fp32'))
        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr):
            runner.encode_references_in_vae_dtype(pipe)
        self.assertFalse(hasattr(pipe, '_encode_vae_image'))
        self.assertIn('no _encode_vae_image', stderr.getvalue())

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
                # The denoiser and text encoder must not stay resident through
                # the float32 decode — that combination OOMs a 32 GB Mac.
                self.assertIsNone(pipe.transformer)
                self.assertIsNone(pipe.text_encoder)
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

    def test_qwen21_mps_frees_the_text_encoder_before_denoising(self):
        emptied = []
        torch = SimpleNamespace(
            bfloat16='bf16', float32='fp32', inference_mode=contextlib.nullcontext,
            mps=SimpleNamespace(empty_cache=lambda: emptied.append(True)),
            backends=SimpleNamespace(mps=SimpleNamespace(is_available=lambda: False)),
            cuda=SimpleNamespace(is_available=lambda: False),
        )
        with patch.dict(sys.modules, {'torch': torch}):
            runner = importlib.import_module('z_image_turbo')
        for device, references in (('mps', 0), ('mps', 2), ('cpu', 0)):
            with self.subTest(device=device, references=references), tempfile.TemporaryDirectory() as directory:
                source = Path(directory) / 'source.png'
                Image.new('RGBA', (16, 16)).save(source)
                argv = ['runner', '--model', 'qwen-image-2.1', '--repo', 'Qwen/Qwen-Image-2.1',
                        '--pipeline-class', 'QwenImage21Pipeline', '--prompt', 'A lighthouse',
                        '--negative-prompt', 'blurry', '--guidance', '4', '--steps', '3',
                        '--seed', '1', '--output', str(Path(directory) / 'output.png')]
                if references:
                    argv += ['--reference-images'] + [str(source)] * references
                pipe = EncodingQwen21Pipeline()
                emptied.clear()
                with patch.object(sys, 'argv', argv), patch.multiple(
                    runner, pick_device=lambda _: device,
                    load_pipeline=lambda *a, **kw: (pipe, device),
                    emit_image_execution_marker=lambda *a: None,
                    apply_memory_optimizations=lambda *a, **kw: None,
                    apply_loras=lambda *a: None,
                    make_generator=lambda *a: 'generator',
                    make_stepwise_callback=lambda *a, **kw: None,
                    decode_qwen21_latents=lambda *a: [Image.new('RGBA', (8, 8))],
                ), contextlib.redirect_stderr(io.StringIO()):
                    runner.main()
                # The prompt and negative prompt (with any reference images)
                # are encoded by a live encoder; on MPS no denoising step runs
                # with it still resident, elsewhere it stays untouched.
                self.assertEqual(pipe.encoded, [('A lighthouse', references), ('blurry', references)])
                resident = device != 'mps'
                self.assertEqual(pipe.encoder_resident_per_step, [resident] * 3)
                self.assertEqual(emptied, [] if resident else [True])
                self.assertEqual(pipe.transformer.hooks, {})


class FakeTransformer:
    def __init__(self):
        self.hooks = {}

    def register_forward_pre_hook(self, hook):
        key = object()
        self.hooks[key] = hook
        return SimpleNamespace(remove=lambda: self.hooks.pop(key))

    def __call__(self, *args):
        for hook in list(self.hooks.values()):
            hook(self, args)


class EncodingQwen21Pipeline:
    """Mirrors the 2.1 call order: encode every prompt, then denoise."""

    def __init__(self):
        self.text_encoder = object()
        self.transformer = FakeTransformer()
        self.vae = SimpleNamespace(to=lambda **_: None, config=SimpleNamespace(latents_mean=None))
        self._encode_vae_image = lambda image, _generator: image
        self.encoded = []
        self.encoder_resident_per_step = []

    def __call__(self, prompt, height, width, num_inference_steps, generator,
                 true_cfg_scale=1.0, image=None, negative_prompt=None, output_type='pil'):
        for text in (prompt, negative_prompt):
            if self.text_encoder is None:
                raise AssertionError('text encoder released before the prompt was encoded')
            self.encoded.append((text, len(image or [])))
        for _ in range(num_inference_steps):
            self.transformer()
            self.encoder_resident_per_step.append(self.text_encoder is not None)
        return SimpleNamespace(images=[Image.new('RGBA', (8, 8))])


if __name__ == '__main__':
    unittest.main()
