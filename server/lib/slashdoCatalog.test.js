import { describe, it, expect } from 'vitest';
import { readdir } from 'fs/promises';
import { join } from 'path';
import {
  SLASHDO_APP_TYPES,
  SLASHDO_COMMAND_NAMES,
  SLASHDO_WORKFLOWS,
  WORKFLOW_OWNS_ITS_OWN_GIT,
  WORKFLOW_REPORTS_NO_CODE,
  getSlashdoWorkflow,
  slashdoWorkflowAppliesTo,
  slashdoWorkflowsForApp,
} from './slashdoCatalog.js';
import { isValidSlashdoCommand, SLASHDO_NAMESPACE } from './slashdoInvocation.js';
import { sanitizeTaskMetadata } from './cosValidation.js';
import { PATHS } from './fileUtils.js';

describe('SLASHDO_WORKFLOWS', () => {
  it('carries every field the consuming surfaces read', () => {
    for (const w of SLASHDO_WORKFLOWS) {
      expect(isValidSlashdoCommand(w.command)).toBe(true);
      expect(w.label).toBeTruthy();
      expect(w.description).toBeTruthy();
      expect(w.detail).toBeTruthy();
      expect(w.icon).toBeTruthy();
      expect(w.templateName).toBeTruthy();
      expect([WORKFLOW_OWNS_ITS_OWN_GIT, WORKFLOW_REPORTS_NO_CODE]).toContain(w.settings);
      expect(Object.values(SLASHDO_APP_TYPES)).toContain(w.appTypes);
    }
  });

  // #3636: the posture a workflow carries declares its DELIVERABLE. The TUI idle
  // reaper fails a clean-tree, no-commit run as `idle-no-changes`, which is
  // correct for the six that land a commit and wrong for the four whose output is
  // a filed issue or a printed report — the reaper cannot see either. Pinned
  // per-command (not derived) so adding a workflow forces the author to decide.
  it('carries the posture matching each workflow deliverable', () => {
    const REPORT_SHAPED = new Set(['plan-task', 'replan', 'review', 'scan']);
    for (const w of SLASHDO_WORKFLOWS) {
      const expected = REPORT_SHAPED.has(w.command) ? WORKFLOW_REPORTS_NO_CODE : WORKFLOW_OWNS_ITS_OWN_GIT;
      expect(w.settings, `${w.command} posture`).toBe(expected);
    }
    // Every command is classified — a new entry can't slip in unconsidered.
    expect(SLASHDO_COMMAND_NAMES.filter(c => REPORT_SHAPED.has(c)).length).toBe(REPORT_SHAPED.size);
  });

  it('keeps the two postures differing only in worktreeChangesExpected', () => {
    expect(WORKFLOW_OWNS_ITS_OWN_GIT).toEqual({
      useWorktree: false, openPR: false, simplify: false, worktreeChangesExpected: true,
    });
    expect(WORKFLOW_REPORTS_NO_CODE).toEqual({
      useWorktree: false, openPR: false, simplify: false, worktreeChangesExpected: false,
    });
    expect(Object.isFrozen(WORKFLOW_OWNS_ITS_OWN_GIT)).toBe(true);
    expect(Object.isFrozen(WORKFLOW_REPORTS_NO_CODE)).toBe(true);
  });

  // The key must survive sanitizeTaskMetadata (#3102) or the posture is inert by
  // the time the task is stored.
  it('carries a worktreeChangesExpected value sanitizeTaskMetadata accepts', () => {
    for (const posture of [WORKFLOW_OWNS_ITS_OWN_GIT, WORKFLOW_REPORTS_NO_CODE]) {
      expect(sanitizeTaskMetadata({ worktreeChangesExpected: posture.worktreeChangesExpected }))
        .toEqual({ worktreeChangesExpected: posture.worktreeChangesExpected });
    }
  });

  it('has no duplicate commands', () => {
    expect(new Set(SLASHDO_COMMAND_NAMES).size).toBe(SLASHDO_COMMAND_NAMES.length);
  });

  // The pre-#3114 drift: `push`/`better-swift` existed only in the route registry,
  // `plan-task`/`depfree`/`scan`/`replan` only in the quick templates. The union is
  // now one list, so both surfaces offer all ten.
  it('is the union of the two pre-convergence catalogs', () => {
    for (const command of [
      'plan-task', 'next', 'replan', 'review', 'push',
      'release', 'better', 'better-swift', 'depfree', 'scan',
    ]) {
      expect(SLASHDO_COMMAND_NAMES).toContain(command);
    }
  });

  it('names only commands the bundled slashdo submodule actually ships', async () => {
    // A catalog entry with no `commands/do/<cmd>.md` would queue a task whose body
    // can never load. Skipped when the submodule isn't checked out. `readdir` (not
    // `loadSlashdoFile`) because that helper can't distinguish "submodule absent"
    // from "command missing".
    const files = await readdir(join(PATHS.slashdo, 'commands/do')).catch(() => null);
    if (!files) return;
    const shipped = new Set(files.filter(f => f.endsWith('.md')).map(f => f.replace(/\.md$/, '')));
    for (const command of SLASHDO_COMMAND_NAMES) {
      expect(shipped, `slashdo ships commands/do/${command}.md`).toContain(command);
    }
  });
});

describe('getSlashdoWorkflow', () => {
  it('resolves a launchable command', () => {
    expect(getSlashdoWorkflow('next')?.label).toBe('Next');
  });

  it('applies the app-type gate', () => {
    expect(slashdoWorkflowAppliesTo(getSlashdoWorkflow('review'), false)).toBe(true);
    expect(slashdoWorkflowAppliesTo(getSlashdoWorkflow('review'), true)).toBe(true);
    expect(slashdoWorkflowAppliesTo(getSlashdoWorkflow('better'), false)).toBe(true);
    expect(slashdoWorkflowAppliesTo(getSlashdoWorkflow('better'), true)).toBe(false);
    expect(slashdoWorkflowAppliesTo(getSlashdoWorkflow('better-swift'), true)).toBe(true);
    expect(slashdoWorkflowAppliesTo(getSlashdoWorkflow('better-swift'), false)).toBe(false);
    // A null workflow (unknown command) applies to nothing.
    expect(slashdoWorkflowAppliesTo(null, false)).toBe(false);
  });

  it('returns null for anything not in the catalog — it is the allowlist gate', () => {
    // `rpr`/`config`/`help` ship with slashdo but are not one-click launchable.
    expect(getSlashdoWorkflow('rpr')).toBeNull();
    expect(getSlashdoWorkflow('help')).toBeNull();
    expect(getSlashdoWorkflow('../../etc/passwd')).toBeNull();
    expect(getSlashdoWorkflow('')).toBeNull();
    expect(getSlashdoWorkflow(null)).toBeNull();
    // A `Map` lookup is what makes prototype keys safe (a plain object would
    // resolve these to Object.prototype members).
    expect(getSlashdoWorkflow('constructor')).toBeNull();
    expect(getSlashdoWorkflow('__proto__')).toBeNull();
  });
});

describe('slashdoWorkflowsForApp', () => {
  it('offers better to a non-Swift app and better-swift to a Swift app, never both', () => {
    const nonSwift = slashdoWorkflowsForApp(false).map(w => w.command);
    expect(nonSwift).toContain('better');
    expect(nonSwift).not.toContain('better-swift');

    const swift = slashdoWorkflowsForApp(true).map(w => w.command);
    expect(swift).toContain('better-swift');
    expect(swift).not.toContain('better');
  });

  it('keeps every ANY workflow for both app kinds', () => {
    const anyCommands = SLASHDO_WORKFLOWS
      .filter(w => w.appTypes === SLASHDO_APP_TYPES.ANY).map(w => w.command);
    for (const isSwift of [false, true]) {
      const offered = slashdoWorkflowsForApp(isSwift).map(w => w.command);
      expect(offered).toEqual(expect.arrayContaining(anyCommands));
    }
  });
});

// The client mirror drives the Agent Operations buttons. The assertion lives HERE
// (not in a client test) and the import direction is one-way, matching the
// app-type mirror in streamingDetect.test.js: the client module is
// dependency-free so a server test can import it, while this catalog isn't
// reachable from a Vite client build.
describe('client mirror of the launchable-workflow catalog', () => {
  // Only the fields the client actually renders — the mirror deliberately drops
  // `icon`/`templateName`/`settings` (server-only) rather than carrying unread
  // copies of them.
  it('agrees on the command list and every field the client renders', async () => {
    const client = await import('../../client/src/lib/slashdoCatalog.js');
    const strip = (w) => ({
      command: w.command,
      description: w.description,
      appTypes: w.appTypes,
      configurable: w.configurable === true,
    });
    expect(client.SLASHDO_WORKFLOWS.map(strip)).toEqual(SLASHDO_WORKFLOWS.map(strip));
  });

  it('agrees on the slash-command spelling used in the UI', async () => {
    const client = await import('../../client/src/lib/slashdoCatalog.js');
    expect(client.SLASHDO_NAMESPACE).toBe(SLASHDO_NAMESPACE);
    for (const command of SLASHDO_COMMAND_NAMES) {
      expect(client.slashdoLabel(command)).toBe(`/${SLASHDO_NAMESPACE}:${command}`);
    }
  });

  it('agrees on the app-type vocabulary and the per-app filter', async () => {
    const client = await import('../../client/src/lib/slashdoCatalog.js');
    expect(client.SLASHDO_APP_TYPES).toEqual(SLASHDO_APP_TYPES);
    for (const isSwift of [false, true]) {
      expect(client.slashdoWorkflowsForApp(isSwift).map(w => w.command))
        .toEqual(slashdoWorkflowsForApp(isSwift).map(w => w.command));
    }
  });

  it('gives every button a style class', async () => {
    const client = await import('../../client/src/lib/slashdoCatalog.js');
    for (const w of client.SLASHDO_WORKFLOWS) expect(w.classes).toBeTruthy();
  });
});
