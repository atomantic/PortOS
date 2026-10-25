"""Controlled lazy-tensor lifecycle at the bridge/common-encoder boundary.

Synthetic arithmetic must match exactly (tolerance zero): the adapter changes
only scheduling, not operations. Real MLX/Gemma tolerances require hardware
measurements and are deliberately not inferred from this fixture.
"""
import contextlib
import gc
import io
import json
import os
import sys
import types
import weakref
from pathlib import Path


def exercise(runner, scenario):
    events, prompts = [], []
    live_text, live_connector = weakref.WeakSet(), weakref.WeakSet()
    failure = None
    split_expected = False

    def fail(stage):
        if failure == stage:
            raise RuntimeError(stage)

    class Lazy:
        def __init__(self, value, owners, stage):
            self.value, self.owners, self.stage = value, owners, stage

        def evaluate(self):
            fail(self.stage)
            self.owners = []

    def materialize(*trees):
        for tree in trees:
            if isinstance(tree, list):
                materialize(*tree)
            else:
                tree.evaluate()
        events.append('materialize')

    class Text:
        def __init__(self):
            if split_expected:
                assert not live_connector
            live_text.add(self)
            self._tokenizer = types.SimpleNamespace(encode=lambda p: p.split())

        def load(self, path):
            events.append('text:' + path)
            fail('text-load')

        def encode_all_layers(self, prompt, max_length):
            fail('text-encode')
            prompts.append((prompt, max_length))
            return ([Lazy(len(prompt) + n, [self], 'hidden-eval') for n in (1, 2)],
                    Lazy([0, 1, 1], [self], 'hidden-eval'))

    class Gemma4LanguageModel(Text):
        pass

    class Connector:
        def __init__(self):
            gc.collect()
            if split_expected:
                assert not live_text, 'text weights still retained'
            events.append('connector')
            fail('connector-allocate')
            live_connector.add(self)
            self.connector = self

        def load_weights(self, weights):
            assert weights == [('projection', 2)]
            fail('connector-load')

        def __call__(self, hidden, attention_mask):
            fail('connector-apply')
            assert attention_mask.value == [0, 1, 1]
            owners = [self, hidden, attention_mask]
            return (Lazy(sum(x.value for x in hidden), owners, 'output-eval'),
                    Lazy(hidden[0].value * 2, owners, 'output-eval'))

    class PromptEncoder:
        def __init__(self):
            self.model_dir = Path('example-model')
            self._text_encoder = self._feature_extractor = None

        def _text_encoder_source(self):
            return ('example-gemma3', Text) if scenario == 'gemma3' else ('example-gemma4', Gemma4LanguageModel)

        def load(self):
            if self._text_encoder is None:
                path, cls = self._text_encoder_source()
                self._text_encoder = cls()
                self._text_encoder.load(path)
            if self._feature_extractor is None:
                self._feature_extractor = Connector()
                self._feature_extractor.load_weights([('projection', 2)])

        def free(self):
            self._text_encoder = self._feature_extractor = None
            gc.collect()

        def encode(self, prompt):
            self.load()
            h, m = self._text_encoder.encode_all_layers(prompt, runner.gemma_max_length())
            return self._feature_extractor(h, attention_mask=m)

        def __call__(self, prompts, *, free_after=True):
            single = isinstance(prompts, str)
            result = []
            for p in [prompts] if single else prompts:
                v, a = self.encode(p)
                materialize(v, a)
                result.append((v.value, a.value))
            if free_after:
                self.free()
            return result[0] if single else result

    pkg = types.ModuleType('ltx_pipelines_mlx')
    utils = types.ModuleType('ltx_pipelines_mlx.utils')
    blocks = types.ModuleType('ltx_pipelines_mlx.utils.blocks')
    blocks.PromptEncoder = PromptEncoder
    blocks.GemmaFeaturesExtractorV2 = Connector
    blocks.aggressive_cleanup = gc.collect
    blocks._materialize = materialize
    blocks.load_split_safetensors = lambda path, prefix: {'projection': 2}
    utils.blocks = blocks
    for module in (pkg, utils, blocks):
        sys.modules[module.__name__] = module
    runner._split_prompt_runtime_supported = lambda module: True
    os.environ['LTX2_GEMMA_MAX_LENGTH'] = '4'

    class Pipeline:
        def __init__(self, model_dir=None, low_ram_streaming=False):
            self.encoder = PromptEncoder()

        def cfg(self, positive, negative):
            self.encoder.load()  # BasePipeline preloads before either CFG lane.
            return self.encoder([positive, negative], free_after=False)

    if scenario != 'markers-after':
        runner.install_prompt_encode_markers()
    baseline = PromptEncoder()([' a cat ', 'negative'])
    prompts.clear()
    events.clear()
    if scenario != 'gemma3':
        runner.install_ltx25_encoder_override(Path('example-override'))
    split_expected = True
    args = types.SimpleNamespace(streaming_mode='stream')
    err = io.StringIO()
    with contextlib.redirect_stderr(err):
        runner.configure_streaming_policy(args, Pipeline, 'ic-lora')
        runner.configure_streaming_policy(args, Pipeline, 'ic-lora')
        runner.install_prompt_encode_markers()
        pipe = Pipeline()
        actual = pipe.cfg(' a cat ', 'negative')
        assert actual == baseline
        assert prompts == [(' a cat ', 4), ('negative', 4)]
        expected_source = 'example-gemma3' if scenario == 'gemma3' else 'example-override'
        assert events.count('text:' + expected_source) == 2
        assert not live_text and not live_connector
        assert PromptEncoder()(' a cat ') == baseline[0]
        if scenario == 'failures':
            for stage in ('text-load', 'text-encode', 'hidden-eval', 'connector-allocate',
                          'connector-load', 'connector-apply', 'output-eval'):
                failure = stage
                encoder = PromptEncoder()
                try:
                    encoder('test')
                except RuntimeError as exc:
                    assert str(exc) == stage
                else:
                    raise AssertionError('failure was swallowed: ' + stage)
                gc.collect()
                assert encoder._text_encoder is None and encoder._feature_extractor is None
                assert not live_text and not live_connector, stage
            failure = None
            encoder = PromptEncoder()
            try:
                encoder('one two three four five')
            except SystemExit as exc:
                assert '5 Gemma tokens' in str(exc)
            else:
                raise AssertionError('token overflow accepted')
            assert encoder._text_encoder is None and encoder._feature_extractor is None
            assert PromptEncoder()(' a cat ') == baseline[0]
        runner.report_streaming_policy()
        split_expected = False
        runner.configure_streaming_policy(types.SimpleNamespace(streaming_mode='resident'), Pipeline, 'one-stage')
        assert PromptEncoder()([' a cat ', 'negative']) == baseline
        assert runner._PROMPT_ENCODE_POLICY == {'mode': 'resident', 'calls': 0}
    lines = err.getvalue().splitlines()
    assert lines.count('STAGE:encode-prompt') == lines.count('STAGE:encode-prompt-done')
    report = json.loads(next(line.split(':', 1)[1] for line in lines if line.startswith('STREAMPOLICY:')))
    assert report['encodePolicy']['mode'] == 'split'
    assert report['encodePolicy']['calls'] >= 3
    return {'equivalent': actual == baseline, 'report': report, 'balancedMarkers': True}
