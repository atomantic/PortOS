import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { resolveTestPython } from '../server/lib/testHelper.js';
import { normalizeJevScores } from '../server/lib/jev.js';

const python = resolveTestPython();
const script = fileURLToPath(new URL('./run_jev.py', import.meta.url));

// Synthetic tokenizer/model doubles exercise the shipped Python runner without
// downloading 9 GB of weights or invoking a provider in the test suite.
const HARNESS = `
import contextlib, json, runpy, sys
from types import SimpleNamespace
helper = runpy.run_path(sys.argv[1])

encoded = []
def encode(text, **kwargs):
    assert kwargs == {"add_special_tokens": True, "truncation": False}, kwargs
    encoded.append(text)
    return list(range(TOKEN_COUNT))
tokenizer = SimpleNamespace(encode=encode, model_max_length=WINDOW)

class Probabilities(list):
    def __getitem__(self, index):
        return SimpleNamespace(item=lambda: list.__getitem__(self, index))

def model(**inputs):
    assert len(inputs["input_ids"]) == 1
    assert inputs["attention_mask"][0] == [1] * len(inputs["input_ids"][0])
    return SimpleNamespace(logits=[None])
# id2label deliberately NOT in (contradiction, entailment, neutral) index order:
# reading the mapping rather than assuming it is the whole point.
model.config = SimpleNamespace(
    id2label={0: "contradiction", 1: "entailment", 2: "neutral"},
    nli_template="Premise: {premise}\\nHypothesis: {hypothesis}",
    max_position_embeddings=WINDOW,
)
model.to = lambda *_args: None
model.eval = lambda: None

def load(value):
    def from_pretrained(_path, **kwargs):
        assert kwargs["local_files_only"] is True and kwargs["trust_remote_code"] is False
        return value
    return SimpleNamespace(from_pretrained=from_pretrained)

sys.modules["transformers"] = SimpleNamespace(
    AutoTokenizer=load(tokenizer),
    AutoModelForSequenceClassification=load(model),
)
sys.modules["torch"] = SimpleNamespace(
    set_num_threads=lambda *_: None,
    inference_mode=contextlib.nullcontext,
    tensor=lambda value: value,
    softmax=lambda *_args, **_kwargs: Probabilities([0.1, 0.85, 0.05]),
    backends=SimpleNamespace(mps=SimpleNamespace(is_available=lambda: False)),
)

state = helper["load_state"](__import__("pathlib").Path("."))
`;

const run = (body, { tokenCount = 64, window = 1024 } = {}) => execFileSync(
  python,
  ['-c', HARNESS.replace('TOKEN_COUNT', String(tokenCount)).replaceAll('WINDOW', String(window)) + body, script],
  { encoding: 'utf8', timeout: 20_000 },
);

describe.skipIf(!python)('jev Python wire contract', () => {
  it('renders the model\'s own NLI template per pair and maps labels by id2label', () => {
    const raw = JSON.parse(run(`
scores = helper["score_pairs"](state, "A premise.", ["first", "second"])
print(json.dumps({"scores": scores, "encoded": encoded, "device": state["device"]}))
`));
    // In request order, one forward pass per pair, and the entailment
    // probability read from the id2label index rather than a fixed slot.
    expect(raw.scores).toEqual([
      { hypothesis: 'first', contradiction: 0.1, entailment: 0.85, neutral: 0.05 },
      { hypothesis: 'second', contradiction: 0.1, entailment: 0.85, neutral: 0.05 },
    ]);
    expect(raw.encoded).toEqual([
      'Premise: A premise.\nHypothesis: first',
      'Premise: A premise.\nHypothesis: second',
    ]);
    expect(raw.device).toBe('cpu');
    expect(normalizeJevScores(
      { schemaVersion: 1, complete: true, scores: raw.scores },
      { hypotheses: ['first', 'second'] },
    ).ok).toBe(true);
  });

  // The regression this uniquely catches: silently truncating and returning a
  // verdict about the PREFIX of a diff. Nothing downstream could detect it.
  it('refuses a pair that overflows the model window instead of truncating it', () => {
    const raw = JSON.parse(run(`
try:
    helper["score_pairs"](state, "A premise.", ["first"])
    print(json.dumps({"code": None}))
except helper["JevError"] as error:
    print(json.dumps({"code": error.code}))
`, { tokenCount: 4096, window: 512 }));
    expect(raw).toEqual({ code: 'jev-premise-too-large' });
  });

  it('validates a request against its declared bounds before importing anything', () => {
    const raw = JSON.parse(run(`
def code_for(payload):
    try:
        helper["validate_request"](payload)
        return None
    except helper["JevError"] as error:
        return error.code

print(json.dumps({
    "ok": helper["validate_request"]({"premise": "p", "hypotheses": ["a"]})[1],
    "empty": code_for({"premise": "  ", "hypotheses": ["a"]}),
    "huge": code_for({"premise": "x" * 40000, "hypotheses": ["a"]}),
    "noHypotheses": code_for({"premise": "p", "hypotheses": []}),
    "tooMany": code_for({"premise": "p", "hypotheses": ["a"] * 33}),
    "longHypothesis": code_for({"premise": "p", "hypotheses": ["a" * 513]}),
    "notAnObject": code_for(["premise"]),
}))
`));
    expect(raw).toEqual({
      ok: ['a'],
      empty: 'jev-request-invalid',
      // The one length failure an operator can act on keeps its own code.
      huge: 'jev-premise-too-large',
      noHypotheses: 'jev-request-invalid',
      tooMany: 'jev-request-invalid',
      longHypothesis: 'jev-request-invalid',
      notAnObject: 'jev-request-invalid',
    });
  });

  it('fails rather than guessing when the checkpoint\'s label set is not the pinned one', () => {
    const raw = JSON.parse(run(`
model.config.id2label = {0: "yes", 1: "no"}
try:
    helper["load_state"](__import__("pathlib").Path("."))
    print(json.dumps({"code": None}))
except helper["JevError"] as error:
    print(json.dumps({"code": error.code}))
`));
    expect(raw).toEqual({ code: 'jev-response-invalid' });
  });
});

describe.skipIf(!python)('jev sidecar bind', () => {
  it('refuses a non-loopback host on the command line', () => {
    const raw = JSON.parse(run(`
sys.argv = ["run_jev", "--model-dir", ".", "--port", "5566", "--host", "0.0.0.0"]
try:
    helper["main"]()
    print(json.dumps({"refused": False}))
except ValueError as error:
    print(json.dumps({"refused": "host must be loopback" in str(error)}))
`));
    expect(raw).toEqual({ refused: true });
  });
});
