import { fileURLToPath } from 'node:url';
import { spawn } from '../../lib/childProcess.js';
import { createMaintenanceAdmission } from '../../lib/maintenanceAdmission.js';

const root = process.env.PORTOS_TEST_HARNESS_ROOT;
const admission = createMaintenanceAdmission(root);
const owner = admission.harnessActions.reserve({ runtime: 'opencode', action: 'update', exclusive: true });
const script = fileURLToPath(new URL('./harnessActionSupervisor.test.fixture.mjs', import.meta.url));
const child = spawn(process.execPath, [script], { detached: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  env: { ...process.env, PORTOS_TEST_HARNESS_OWNER: owner.id, PORTOS_TEST_HARNESS_GRACE_MS: '1000' } });
child.stdout.pipe(process.stdout, { end: false });
child.stderr.pipe(process.stderr, { end: false });
child.on('message', message => process.send({ type: 'wrapper', message }));
process.on('message', message => { if (child.connected) child.send(message); });
process.send({ type: 'owner-created', ownerId: owner.id, wrapperPid: child.pid });
