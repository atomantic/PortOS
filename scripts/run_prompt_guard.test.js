import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { resolveTestPython } from '../server/lib/testHelper.js';
import { normalizeModelAbuseGuardResult } from '../server/lib/modelAbuseGuard.js';

const python = resolveTestPython();
const script = fileURLToPath(new URL('./run_prompt_guard.py', import.meta.url));

describe.skipIf(!python)('Prompt Guard Python wire contract', () => {
  it('covers every overflow window using batched tensors and emits a complete Node-verifiable result', () => {
    // Synthetic tokenizer/model doubles exercise the shipped Python runner
    // without downloading weights or invoking a provider in the test suite.
    const program = `
import contextlib, io, json, runpy, sys, tempfile
from types import SimpleNamespace
helper = runpy.run_path(sys.argv[1])
def tokenizer(text, **kwargs):
    assert kwargs["return_overflowing_tokens"] is True
    assert kwargs["max_length"] == 512 and kwargs["stride"] == 64
    return {"input_ids": [[1] * 512, [1] * 256], "attention_mask": [[1] * 512, [1] * 256], "overflow_to_sample_mapping": [0, 0]}
tokenizer.encode = lambda *_args, **_kwargs: [1] * 700
tokenizer.num_special_tokens_to_add = lambda **_kwargs: 2
def model(**inputs):
    assert len(inputs["input_ids"]) == 1
    assert len(inputs["input_ids"][0]) in (512, 256)
    assert "overflow_to_sample_mapping" not in inputs
    return SimpleNamespace(logits=[[]])
model.config = SimpleNamespace(id2label={0: "BENIGN"})
model.to = lambda *_args: None
model.eval = lambda: None
def load(value):
    def from_pretrained(_path, **kwargs):
        assert kwargs["local_files_only"] is True and kwargs["trust_remote_code"] is False
        return value
    return SimpleNamespace(from_pretrained=from_pretrained)
sys.modules["transformers"] = SimpleNamespace(AutoTokenizer=load(tokenizer), AutoModelForSequenceClassification=load(model))
sys.modules["torch"] = SimpleNamespace(set_num_threads=lambda *_: None, inference_mode=contextlib.nullcontext, tensor=lambda value: value, softmax=lambda *_args, **_kwargs: [SimpleNamespace(item=lambda: 0.99)], argmax=lambda *_: SimpleNamespace(item=lambda: 0))
with tempfile.TemporaryDirectory() as directory:
    sys.argv = ["run_prompt_guard", "--model-dir", directory]
    sys.stdin = io.StringIO(json.dumps({"text": "Example text with multiple token windows."}))
    assert helper["main"]() == 0
`;
    const raw = JSON.parse(execFileSync(python, ['-c', program, script], { encoding: 'utf8', timeout: 10_000 }));
    expect(raw).toMatchObject({ complete: true, tokenCount: 700, chunks: [{ tokenStart: 0, tokenEnd: 510 }, { tokenStart: 446, tokenEnd: 700 }] });
    expect(normalizeModelAbuseGuardResult(raw)).toMatchObject({ ok: true, safe: true, chunkCount: 2 });
  });
});
