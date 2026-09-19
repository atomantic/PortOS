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
# The base encoder the kit hooks to capture ONLY the final hidden state. The
# real one is a PreTrainedModel; all the kit needs of it is a place to hang a
# forward hook, so the double records the handler and lets each test fire it.
hooks = []
model.base_model = SimpleNamespace(
    register_forward_hook=lambda fn: hooks.append(fn) or SimpleNamespace(remove=lambda: None)
)

def load(value):
    def from_pretrained(_path, **kwargs):
        assert kwargs["local_files_only"] is True and kwargs["trust_remote_code"] is False
        return value
    return SimpleNamespace(from_pretrained=from_pretrained)

sys.modules["transformers"] = SimpleNamespace(
    AutoTokenizer=load(tokenizer),
    AutoModelForSequenceClassification=load(model),
)
# A tensor double that still compares equal to the plain list the assertions
# above use, but carries the device move the trained-head path performs.
class Tensor(list):
    def to(self, *_args):
        return self

sys.modules["torch"] = SimpleNamespace(
    set_num_threads=lambda *_: None,
    inference_mode=contextlib.nullcontext,
    tensor=Tensor,
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

describe.skipIf(!python)('jev trained project head', () => {
  // The regression this uniquely catches: an adopted head changing the WIRE
  // SHAPE. `normalizeJevScores` matches the reply against the hypotheses that
  // were asked about, position for position — a head that dropped a label or
  // re-ordered the list would be rejected as a contract break rather than
  // scored, and the install would silently lose the feature it just adopted.
  it('scores through a head with the same shape and order the stock classifier uses', () => {
    const raw = JSON.parse(run(`
# Extend the model double with the hidden states pool_pair reads. The last row
# is what last-token pooling must select, so a mean or first-token pooling
# would produce a different winner rather than a slightly different number.
class Row(list):
    def to(self, *_args):
        return self
    def float(self):
        return self
    def tolist(self):
        return list(self)

class Hidden:
    def __getitem__(self, key):
        assert key == (0, -1, slice(None)), key
        return Row([0.0, 3.0, 0.0])

# The kit hooks the BASE model and reads what the hook captured, so the double
# fires the registered hook rather than returning hidden states inline — and
# asserts the caller no longer pays for every layer's activations.
def model_with_hidden(**inputs):
    assert "output_hidden_states" not in inputs, inputs
    for hook in hooks:
        hook(None, None, (Hidden(),))
    return SimpleNamespace(logits=[Row([0.0, 0.0, 0.0])])
model_with_hidden.config = model.config
state["model"] = model_with_hidden

head = {
    "schemaVersion": 1, "decisionId": "scope-adherence", "architecture": "linear",
    "pooling": "last-token",
    "baseModel": {"id": "m", "repository": "r", "revision": "rev"},
    "hiddenSize": 3, "labels": ["contradiction", "entailment", "neutral"],
    "layers": [{"weight": [[1, 0, 0], [0, 1, 0], [0, 0, 1]], "bias": [0, 0, 0]}],
    "metrics": {"trained": 0.7, "stockZeroShot": 0.5, "majorityClass": 0.4, "goldSize": 40, "trainSize": 120},
    "corpusHash": "deadbeefcafe0001", "corpusSources": ["merged-pr"],
    "trainedAt": "2026-09-19T00:00:00.000Z",
}
scores = helper["score_with_head"](state, head, "A premise.", ["first", "second"])
print(json.dumps({"scores": scores, "keys": sorted(scores[0].keys())}))
`));
    expect(raw.keys).toEqual(['contradiction', 'entailment', 'hypothesis', 'neutral']);
    expect(raw.scores.map((score) => score.hypothesis)).toEqual(['first', 'second']);
    // Row 1 of the head reads input 1, which carries the 3.0 — so entailment
    // wins only if last-token pooling and the label order both held.
    for (const score of raw.scores) {
      expect(score.entailment).toBeGreaterThan(score.contradiction);
      expect(score.entailment).toBeGreaterThan(score.neutral);
      expect(score.contradiction + score.entailment + score.neutral).toBeCloseTo(1, 9);
    }
    expect(normalizeJevScores(
      { schemaVersion: 1, complete: true, scores: raw.scores },
      { hypotheses: ['first', 'second'] },
    ).ok).toBe(true);
  });

  it('accepts a head name on a scoring request and defaults to none', () => {
    const raw = JSON.parse(run(`
def head_for(payload):
    try:
        return {"head": helper["validate_request"](payload)[2]}
    except helper["JevError"] as error:
        return {"code": error.code}

print(json.dumps({
    "absent": head_for({"premise": "p", "hypotheses": ["a"]}),
    "named": head_for({"premise": "p", "hypotheses": ["a"], "head": "scope-adherence"}),
    "null": head_for({"premise": "p", "hypotheses": ["a"], "head": None}),
    "blank": head_for({"premise": "p", "hypotheses": ["a"], "head": ""}),
    "notAString": head_for({"premise": "p", "hypotheses": ["a"], "head": 7}),
}))
`));
    expect(raw).toEqual({
      // Absent, null and blank all mean "the stock classifier answers" — the
      // state every install ships in.
      absent: { head: null },
      named: { head: 'scope-adherence' },
      null: { head: null },
      blank: { head: null },
      notAString: { code: 'jev-request-invalid' },
    });
  });
});
