import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { api, currentSearch, renderPage, toast } from '../../test/promptManagerPageMocks.jsx';

// Agent Skills tab (#17391): the curator's telemetry and controls over the
// skill registry, rendered through the real Prompt Manager page and routes.
const usage = (overrides = {}) => ({
  viewCount: 3, useCount: 2, patchCount: 1, lastUsedAt: null, lastViewedAt: null, lastPatchedAt: null,
  createdAt: null, createdBy: 'agent', state: 'active', pinned: false, locked: false, archivedAt: null, ...overrides,
});
const LIST = {
  skills: [
    { id: 'local:deploy', name: 'deploy', description: 'Ship it', tier: 'local', path: 'deploy', usage: usage() },
    { id: 'local:notes', name: 'notes', description: 'Write notes', tier: 'local', path: 'notes', usage: usage({ state: 'stale', locked: true, createdBy: 'user' }) },
    { id: 'shipped:triage', name: 'triage', description: 'Shipped triage', tier: 'shipped', path: 'triage', usage: usage({ createdBy: null }) },
  ],
  archived: [
    { id: 'archive:old', name: 'old', description: 'Old one', tier: 'local', path: 'old', originalId: 'local:old', usage: usage({ state: 'archived' }) },
  ],
  quarantined: [{ id: 'external-1:bad', name: 'bad', tier: 'external', findings: [{ reason: 'Instruction override' }] }],
};
const STATUS = {
  config: { staleAfterDays: 14, archiveAfterDays: 30 },
  counts: { active: 2, stale: 1, archived: 1, pinned: 0, locked: 1, agentCreated: 1 },
  lastRun: null,
  job: { id: 'job-skill-curator', enabled: false, lastRun: null },
};

describe('AgentSkillsEditor', () => {
  beforeEach(() => {
    api.getSkills.mockReset().mockResolvedValue(LIST);
    api.getCuratorStatus.mockReset().mockResolvedValue(STATUS);
    api.viewSkill.mockReset().mockImplementation((ref) => Promise.resolve({ content: `# ${ref} body` }));
    api.editSkill.mockReset().mockResolvedValue({ ok: true });
    api.applySkillAction.mockReset();
    api.runCurator.mockReset();
    api.getSkillLedger.mockReset().mockResolvedValue({ entries: [] });
    api.rollbackSkillLedgerEntry.mockReset();
    toast.success.mockReset();
    toast.error.mockReset();
  });

  it('lists skills with state badges, archived and quarantined sections, and curator counts', async () => {
    await renderPage('/prompts/agent-skills');
    await screen.findByText('deploy');
    expect(screen.getByText('stale')).toBeTruthy();
    expect(screen.getByText('locked')).toBeTruthy();
    expect(screen.getByText('old')).toBeTruthy();
    expect(screen.getByText('quarantined')).toBeTruthy();
    expect(screen.getByText('Instruction override')).toBeTruthy();
    expect(screen.getByText(/2 active · 1 stale · 1 archived/)).toBeTruthy();
    expect(screen.getByText(/Scheduled job disabled/)).toBeTruthy();
  });

  it('deep-links the selected skill and saves a human edit through the edit route', async () => {
    await renderPage('/prompts/agent-skills');
    fireEvent.click(await screen.findByText('deploy'));
    await waitFor(() => expect(currentSearch()).toContain('agentSkill=local%3Adeploy'));
    const box = await screen.findByDisplayValue('# local:deploy body');
    expect(screen.getByText(/3 views · 2 agent uses · 1 edits/)).toBeTruthy();

    fireEvent.change(box, { target: { value: '# local:deploy body\nMore.' } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => expect(api.editSkill).toHaveBeenCalledWith(
      { action: 'patch', name: 'local:deploy', oldString: '# local:deploy body', newString: '# local:deploy body\nMore.' },
      { silent: true },
    ));
    expect(toast.success).toHaveBeenCalledWith('Skill saved');
  });

  it('pins, unlocks and archives a local skill, following it into the archive', async () => {
    await renderPage('/prompts/agent-skills?agentSkill=local%3Anotes');
    await screen.findByDisplayValue('# local:notes body');
    expect(screen.getByText(/Locked: agents cannot change/)).toBeTruthy();

    api.applySkillAction.mockResolvedValueOnce({ ok: true, usage: usage({ pinned: true }) });
    fireEvent.click(screen.getByRole('button', { name: 'Pin' }));
    await waitFor(() => expect(api.applySkillAction).toHaveBeenCalledWith('local:notes', 'pin', { silent: true }));

    api.applySkillAction.mockResolvedValueOnce({ ok: true, usage: usage({ locked: false }) });
    fireEvent.click(await screen.findByRole('button', { name: 'Unlock' }));
    await waitFor(() => expect(api.applySkillAction).toHaveBeenCalledWith('local:notes', 'unlock', { silent: true }));

    // A user-made skill can be handed to the curator explicitly.
    expect(screen.getByRole('button', { name: 'Let curator manage' })).toBeTruthy();

    api.applySkillAction.mockResolvedValueOnce({ ok: true, archivePath: '.archive/notes' });
    fireEvent.click(screen.getByRole('button', { name: 'Archive' }));
    fireEvent.click(within(screen.getByLabelText('Confirm archiving notes')).getByRole('button', { name: 'Archive' }));
    await waitFor(() => expect(api.applySkillAction).toHaveBeenCalledWith('local:notes', 'archive', { silent: true }));
    await waitFor(() => expect(currentSearch()).toContain('agentSkill=archive%3Anotes'));
  });

  it('restores an archived skill by its original id and keeps shipped skills read-only', async () => {
    await renderPage('/prompts/agent-skills?agentSkill=archive%3Aold');
    expect(await screen.findByText(/Archived skills are hidden from agents/)).toBeTruthy();
    expect(api.viewSkill).not.toHaveBeenCalled();
    api.applySkillAction.mockResolvedValueOnce({ ok: true, skill: { id: 'local:old' } });
    fireEvent.click(screen.getByRole('button', { name: 'Restore' }));
    await waitFor(() => expect(api.applySkillAction).toHaveBeenCalledWith('local:old', 'restore', { silent: true }));
    await waitFor(() => expect(currentSearch()).toContain('agentSkill=local%3Aold'));

    fireEvent.click(screen.getByText('triage'));
    const box = await screen.findByDisplayValue('# shipped:triage body');
    expect(box.readOnly).toBe(true);
    expect(screen.queryByRole('button', { name: 'Pin' })).toBeNull();
    expect(screen.queryByRole('button', { name: /save/i })).toBeNull();
  });

  it('re-reads the open skill after rolling back one of its changes', async () => {
    api.getSkillLedger.mockResolvedValue({ entries: [
      { id: 'e2', at: new Date().toISOString(), actor: 'agent', action: 'patch', skill: { id: 'local:deploy' }, before: { files: 1 }, after: { files: 1 } },
    ] });
    api.rollbackSkillLedgerEntry.mockResolvedValueOnce({ ok: true, restored: ['deploy/SKILL.md'], removed: [], usageReconciled: true });
    await renderPage('/prompts/agent-skills?agentSkill=local%3Adeploy');
    await screen.findByDisplayValue('# local:deploy body');
    api.viewSkill.mockResolvedValueOnce({ content: '# restored body' });
    fireEvent.click(screen.getByRole('button', { name: 'History' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Roll back' }));
    fireEvent.click(within(screen.getByLabelText('Confirm rolling back patch of local:deploy')).getByRole('button', { name: 'Roll back' }));
    const box = await screen.findByDisplayValue('# restored body');

    // The next save patches from the restored text, not the stale one.
    fireEvent.change(box, { target: { value: '# restored body!' } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => expect(api.editSkill).toHaveBeenCalledWith(
      expect.objectContaining({ oldString: '# restored body', newString: '# restored body!' }), { silent: true },
    ));
  });

  it('keeps the newly opened skill\'s baseline when an earlier save lands late', async () => {
    let finishSave;
    api.editSkill.mockImplementationOnce(() => new Promise((resolve) => { finishSave = resolve; }));
    await renderPage('/prompts/agent-skills?agentSkill=local%3Adeploy');
    const box = await screen.findByDisplayValue('# local:deploy body');
    fireEvent.change(box, { target: { value: 'edited deploy' } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    // Rows are locked while the save is in flight.
    expect(screen.getByText('notes').closest('button').disabled).toBe(true);
    finishSave({ ok: true });
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Skill saved'));

    fireEvent.click(screen.getByText('notes'));
    const notes = await screen.findByDisplayValue('# local:notes body');
    fireEvent.change(notes, { target: { value: '# local:notes body!' } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => expect(api.editSkill).toHaveBeenLastCalledWith(
      expect.objectContaining({ name: 'local:notes', oldString: '# local:notes body' }), { silent: true },
    ));
  });

  it('holds rollback and a live curator pass while the open skill has unsaved edits', async () => {
    api.getSkillLedger.mockResolvedValue({ entries: [
      { id: 'e3', at: new Date().toISOString(), actor: 'agent', action: 'patch', skill: { id: 'local:deploy' }, before: { files: 1 }, after: { files: 1 } },
    ] });
    await renderPage('/prompts/agent-skills?agentSkill=local%3Adeploy');
    fireEvent.change(await screen.findByDisplayValue('# local:deploy body'), { target: { value: 'draft' } });
    expect(screen.getByRole('button', { name: 'Run now' }).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'History' }));
    expect((await screen.findByRole('button', { name: 'Roll back' })).disabled).toBe(true);
    expect(screen.getByDisplayValue('draft')).toBeTruthy();
  });

  it('follows the open skill into the archive after a curator pass moves it', async () => {
    api.runCurator.mockResolvedValueOnce({ dryRun: false, transitions: [{ id: 'local:deploy', from: 'stale', to: 'archived', idleDays: 40 }], failures: [] });
    await renderPage('/prompts/agent-skills?agentSkill=local%3Adeploy');
    await screen.findByDisplayValue('# local:deploy body');
    api.getSkills.mockResolvedValue({
      ...LIST,
      skills: LIST.skills.filter((entry) => entry.id !== 'local:deploy'),
      archived: [...LIST.archived, { id: 'archive:deploy', name: 'deploy', tier: 'local', path: 'deploy', originalId: 'local:deploy', usage: usage({ state: 'archived' }) }],
    });
    fireEvent.click(screen.getByRole('button', { name: 'Run now' }));
    fireEvent.click(screen.getByRole('button', { name: 'Run pass' }));
    await waitFor(() => expect(currentSearch()).toContain('agentSkill=archive%3Adeploy'));
    expect(await screen.findByText(/Archived skills are hidden from agents/)).toBeTruthy();
  });

  it('previews a curator pass without applying it', async () => {
    api.runCurator.mockResolvedValueOnce({ dryRun: true, transitions: [{ id: 'local:deploy', from: 'active', to: 'stale', idleDays: 20 }], failures: [] });
    await renderPage('/prompts/agent-skills');
    fireEvent.click(await screen.findByRole('button', { name: 'Preview pass' }));
    await screen.findByText('Planned changes (nothing applied)');
    expect(screen.getByText('local:deploy: active → stale (20 idle days)')).toBeTruthy();
    expect(api.runCurator).toHaveBeenCalledWith({ dryRun: true }, { silent: true });
  });

  it('rolls back one change from the history drawer after confirmation', async () => {
    api.getSkillLedger.mockResolvedValue({ entries: [
      { id: 'e1', at: new Date().toISOString(), actor: 'agent', action: 'delete', skill: { id: 'local:gone' }, before: { files: 2 }, after: null },
    ] });
    api.rollbackSkillLedgerEntry.mockResolvedValueOnce({ ok: true, restored: ['gone/SKILL.md'], removed: [], usageReconciled: true });
    await renderPage('/prompts/agent-skills');
    fireEvent.click(await screen.findByRole('button', { name: 'History' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Roll back' }));
    fireEvent.click(within(screen.getByLabelText('Confirm rolling back delete of local:gone')).getByRole('button', { name: 'Roll back' }));
    await waitFor(() => expect(api.rollbackSkillLedgerEntry).toHaveBeenCalledWith('e1', { silent: true }));
    expect(toast.success).toHaveBeenCalledWith('Rolled back delete of local:gone');
  });

  it('says telemetry is unavailable instead of showing zero counts', async () => {
    api.getSkills.mockResolvedValue({ ...LIST, skills: LIST.skills.map(({ usage: _u, ...rest }) => rest), usageUnavailable: true });
    api.getCuratorStatus.mockResolvedValue({ ...STATUS, counts: null });
    await renderPage('/prompts/agent-skills');
    await screen.findByText(/Usage telemetry is unreadable, so counts/);
    expect(screen.getByRole('button', { name: 'Preview pass' }).disabled).toBe(true);
  });
});
