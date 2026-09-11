import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { resolveTestPython } from '../server/lib/testHelper.js';
import { normalizeModelAbuseGuardResult } from '../server/lib/modelAbuseGuard.js';

const python = resolveTestPython();
const script = fileURLToPath(new URL('./run_prompt_guard.py', import.meta.url));

describe.skipIf(!python)('Prompt Guard Python wire contract', () => {
  it('classifies every token in overlapping batched windows without the broken overflow API', () => {
    // Synthetic tokenizer/model doubles exercise the shipped Python runner
    // without downloading weights or invoking a provider in the test suite.
    const program = `
import contextlib, io, json, runpy, sys, tempfile
from types import SimpleNamespace
helper = runpy.run_path(sys.argv[1])
def tokenizer(*_args, **_kwargs):
    raise AssertionError("must not re-tokenize through the truncating overflow API")
def encode(_text, **kwargs):
    assert kwargs == {"add_special_tokens": False, "truncation": False}
    return list(range(10, 710))
tokenizer.encode = encode
tokenizer.num_special_tokens_to_add = lambda **_kwargs: 2
tokenizer.cls_token_id = 1
tokenizer.sep_token_id = 2
calls = []
def model(**inputs):
    assert len(inputs["input_ids"]) == 1
    assert len(inputs["input_ids"][0]) in (512, 256)
    start = 0 if not calls else 446
    end = 510 if not calls else 700
    assert inputs["input_ids"][0] == [1, *range(10 + start, 10 + end), 2]
    assert inputs["attention_mask"][0] == [1] * (end - start + 2)
    calls.append(start)
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
