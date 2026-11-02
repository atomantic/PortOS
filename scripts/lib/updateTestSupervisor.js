import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join, dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Run the real admission supervisor against a synthetic script and private data. */
export function installUpdateTestSupervisor(repo, { standalone = false } = {}) {
  writeFileSync(join(repo, '.portos-disposable-root'), '');
  mkdirSync(join(repo, 'scripts'), { recursive: true });
  if (standalone) {
    const sourceRoot = fileURLToPath(new URL('../../', import.meta.url));
    const copied = new Set();
    const copyModule = source => {
      if (copied.has(source)) return;
      copied.add(source);
      const text = readFileSync(source, 'utf8');
      const target = join(repo, relative(sourceRoot, source));
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, text);
      for (const match of text.matchAll(/from\s+['"](\.[^'"]+)['"]/g)) copyModule(resolve(dirname(source), match[1]));
    };
    copyModule(join(sourceRoot, 'scripts/deferred-update.mjs'));
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ type: 'module' }));
    return;
  }
  const supervisor = new URL('../deferred-update.mjs', import.meta.url).href;
  const admission = new URL('../../server/lib/maintenanceAdmission.js', import.meta.url).href;
  writeFileSync(join(repo, 'scripts/deferred-update.mjs'), `
import { runDeferredUpdate, enterUpdate } from ${JSON.stringify(supervisor)};
import { createMaintenanceAdmission } from ${JSON.stringify(admission)};
const admission = createMaintenanceAdmission(${JSON.stringify(join(repo, 'data'))}, {
  assertWrite: path => { if (path !== ${JSON.stringify(join(repo, 'data/workflow-maintenance'))}) throw new Error('Unexpected fixture write'); },
});
const [command, id, pid, code] = process.argv.slice(2);
if (command === '--enter') enterUpdate(id, Number(pid), admission);
else if (command === '--terminal') admission.deferredUpdate.terminal(id, Number(pid), code === '0');
else {
  const controller = new AbortController();
  process.on('SIGTERM', () => controller.abort());
  process.on('SIGINT', () => controller.abort());
  process.exitCode = await runDeferredUpdate({ admission, cwd: ${JSON.stringify(repo)}, signal: controller.signal });
}
`);
}
