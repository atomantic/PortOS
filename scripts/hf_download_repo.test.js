import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveTestPython } from '../server/lib/testHelper.js';

const script = join(dirname(fileURLToPath(import.meta.url)), 'hf_download_repo.py');
const pyBin = resolveTestPython();
const runPython = (source) => execFileSync(pyBin, ['-c', source, script], {
  encoding: 'utf8',
});

const importHelper = [
  'import importlib.util, sys',
  'from pathlib import Path',
  'script = Path(sys.argv[1])',
  'spec = importlib.util.spec_from_file_location("hf_download_repo", script)',
  'helper = importlib.util.module_from_spec(spec)',
  'spec.loader.exec_module(helper)',
].join('\n');

describe.skipIf(!pyBin)('hf_download_repo.py helpers', () => {
  it('maps a repo id onto the HF hub cache folder name', () => {
    const output = runPython(`${importHelper}
print(helper.repo_cache_dir("ethanfel/Qwen3-VL-32B", "/tmp/hf-hub"))
`);
    expect(output.trim()).toMatch(/models--ethanfel--Qwen3-VL-32B$/);
  });

  it('sums only incomplete blobs under the repo cache', () => {
    const output = runPython(`${importHelper}
import tempfile
with tempfile.TemporaryDirectory() as temp:
    root = Path(temp)
    blobs = root / "blobs"
    blobs.mkdir()
    (blobs / "aaa.incomplete").write_bytes(b"x" * 100)
    (blobs / "bbb.incomplete").write_bytes(b"y" * 50)
    (blobs / "done").write_bytes(b"z" * 999)
    print(helper.incomplete_bytes(root))
`);
    expect(output.trim()).toBe('150');
  });

  it('returns 0 when the cache dir does not exist yet', () => {
    const output = runPython(`${importHelper}
print(helper.incomplete_bytes("/tmp/portos-hf-cache-does-not-exist"))
`);
    expect(output.trim()).toBe('0');
  });

  it('formats the STAGE:bytes / STAGE:verify wire lines the JS parser expects', () => {
    const output = runPython(`${importHelper}
print(helper.format_bytes_stage(1, 1, 26843545600, 51506295440, "qwen3vl.safetensors"))
print(helper.format_verify_stage(1, 1, "qwen3vl.safetensors"))
`);
    // Python's print() emits CRLF on Windows, and `.trim()` only strips the ends
    // of the whole payload — a bare split('\n') leaves a trailing \r on every
    // line but the last, so the first assertion compared against 'STAGE:…\r'.
    const [bytes, verify] = output.trim().split(/\r?\n/);
    expect(bytes).toBe('STAGE:bytes:1/1:26843545600/51506295440:qwen3vl.safetensors');
    expect(verify).toBe('STAGE:verify:1/1:qwen3vl.safetensors');
  });
});
