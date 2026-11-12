import { expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { execFileSync } from '../../../lib/childProcess.js';
import { PY_SUBPROCESS_TIMEOUT_MS, PY_TEST_TIMEOUT_MS, resolveTestPython } from '../../../lib/testHelper.js';

const python = resolveTestPython();
const driver = fileURLToPath(new URL('./py/portos_blender_driver.py', import.meta.url));

it.skipIf(!python)('a canceled Blender frame emits no traceback, and a resumed frame can finish atomically', () => {
  const script = `
import ast, os, sys, tempfile, types
source = open(sys.argv[1]).read()
tree = ast.parse(source)
frame = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == "render_frame")
scene = types.SimpleNamespace(render=types.SimpleNamespace(filepath=None))
ops = types.SimpleNamespace(render=types.SimpleNamespace(render=lambda **kw: None))
namespace = {"os": os, "bpy": types.SimpleNamespace(ops=ops)}
exec(compile(ast.Module(body=[frame], type_ignores=[]), sys.argv[1], "exec"), namespace)
with tempfile.TemporaryDirectory() as directory:
    target = os.path.join(directory, "frame.png")
    # Exercise the actual top-level exception handler, replacing only main.
    namespace["main"] = lambda: namespace["render_frame"](scene, target)
    namespace["sys"] = sys
    namespace["emit"] = lambda *a, **k: (_ for _ in ()).throw(AssertionError("error event emitted"))
    handler = tree.body[-1]
    try:
        exec(compile(ast.Module(body=[handler], type_ignores=[]), sys.argv[1], "exec"), namespace)
    except SystemExit as result:
        assert result.code == 130
    else:
        raise AssertionError("canceled frame reported success")
    assert not os.path.exists(target)
    def render(**kwargs):
        with open(scene.render.filepath, "wb") as out:
            out.write(b"complete frame")
    ops.render.render = render
    namespace["render_frame"](scene, target)
    assert open(target, "rb").read() == b"complete frame"
    assert not os.path.exists(os.path.join(directory, "frame.part.png"))
print("resumed")
`;
  expect(execFileSync(python, ['-c', script, driver], { encoding: 'utf8', timeout: PY_SUBPROCESS_TIMEOUT_MS }).trim())
    .toBe('Render canceled\nresumed');
}, PY_TEST_TIMEOUT_MS);
