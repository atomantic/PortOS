// Shared by the server setup and generated subprocess workflow fixtures.
// Keep the real coordination protocol, while owning every journal and its cleanup.
import { vi, afterAll } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Exercise the real gate in workflow tests, with private test-owned journals.
// Register teardown in setup (not inside a lazy mock factory); resetModules can
// otherwise create a journal after the file's teardown hooks were collected.
const coordinatorTestRoots = [];
afterAll(() => {
  for (const entry of coordinatorTestRoots.splice(0)) {
    entry.closed = true;
    entry.io.rmSync(entry.root, { recursive: true, force: true });
  }
});
vi.mock('../lib/maintenanceAdmission.js', async (importOriginal) => {
  const actual = await importOriginal();
  const io = await vi.importActual('node:fs');
  const { randomUUID } = await vi.importActual('node:crypto');
  const root = io.mkdtempSync(join(tmpdir(), 'maintenance-workflow-'));
  const entry = { io, root, closed: false };
  coordinatorTestRoots.push(entry);
  return { ...actual, maintenance: actual.createMaintenanceAdmission(root, { io, makeId: randomUUID, assertWrite: path => {
    // Domain suites mock fs/UUIDs wholesale. Keep the journal private and real.
    if (entry.closed || path !== join(root, 'workflow-maintenance')) throw new Error('Unexpected maintenance test path');
  } }) };
});

// Publication admission remains real, but never shares ownership with the install
// or another test file. Use real fs/UUIDs even when domain suites mock them.
vi.mock('../lib/backupSharedAdmission.js', async (importOriginal) => {
  const actual = await importOriginal();
  const io = await vi.importActual('node:fs');
  const { randomUUID } = await vi.importActual('node:crypto');
  const { type } = await vi.importActual('node:os');
  const root = io.mkdtempSync(join(tmpdir(), 'backup-admission-workflow-'));
  const entry = { io, root, closed: false };
  coordinatorTestRoots.push(entry);
  return { ...actual, backupSharedAdmission: actual.createBackupSharedAdmission(root, { io, makeId: randomUUID, syncDirectories: type() !== 'Windows_NT', assertWrite: path => {
    if (entry.closed || path !== root) throw new Error('Unexpected backup admission test path');
  } }) };
});
