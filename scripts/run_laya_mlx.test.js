import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { resolveTestPython } from '../server/lib/testHelper.js';
const python = resolveTestPython();
const script = fileURLToPath(new URL('./run_laya_mlx.py', import.meta.url));

// The regression is silent upstream truncation: a long option, question or
// premise must never reach predict as if it were the complete user input.
it.skipIf(!python)('rejects every truncation boundary before inference, while allowing a fitting request', () => {
  const result = execFileSync(python, ['-c', `
import json, runpy, sys
from types import SimpleNamespace
common = SimpleNamespace(
    build_prefix=lambda tok, q, budget: (list(range(len(q['instructions']) + 4)), []),
    render_options=lambda q: q['criteria'],
    serialize_state=lambda state: state,
)
sys.modules['laya_mlx.common'] = common
score = runpy.run_path(sys.argv[1])['score']
class Tokenizer:
    mask_token = '[MASK]'
    def __call__(self, text, **kwargs):
        return {'input_ids': list(range(len(text)))}
calls = []
agent = SimpleNamespace(tok=Tokenizer(), cfg={'max_len': 100, 'head_max_len': 40},
    _to_internal=lambda q: q, predict=lambda state, q: calls.append(state) or {'ok': True})
request = {'premise': 'A short state', 'instructions': 'Choose', 'options': ['one', 'two']}
assert score(agent, request) == {'ok': True}
for patch in [{'premise': 's' * 100}, {'instructions': 'q' * 50}, {'options': ['x' * 49, 'two']}]:
    assert score(agent, {**request, **patch}) == {'code': 'laya-context-too-long'}
assert calls == ['A short state'], calls
print('ok')
`, script], { encoding: 'utf8' });
  expect(result.trim()).toBe('ok');
});
