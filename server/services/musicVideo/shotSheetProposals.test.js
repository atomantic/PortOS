import { beforeEach, describe, expect, it, vi } from 'vitest';

const project = {
  id: 'p', concept: { prompt: 'Two teens', subjects: [{ kind: 'character', name: 'Ada' }] },
  cameras: [{ id: 'vhs', name: 'VHS', kind: 'in-world', rule: 'Ben owns it' }],
  scenes: [{ sceneId: 'a', label: 'Shot 1', startSec: 0, endSec: 2, framePrompt: 'Frame A', prompt: 'Motion A', shotSheet: { emotion: 'Scared' } }, { sceneId: 'b', label: 'Shot 2', startSec: 2, endSec: 4 }],
};
vi.mock('./requireProject.js', () => ({ requireProject: vi.fn(async () => project) }));
const { proposeShotSheet, __setShotSheetDepsForTests } = await import('./shotSheetProposals.js');
const { shotSheetProposeSchema } = await import('../../lib/musicVideoStoryValidation.js');
const { mergeShotSheetBackfill } = await import('../../lib/musicVideoShotSheet.js');
const { FRAME_PROMPT_WRITING, CLIP_PROMPT_WRITING } = await import('../../lib/musicVideoShotPrompt.js');

const provider = { id: 'prov', enabled: true, type: 'api' };
const run = vi.fn();
const base = { providerId: 'prov', sceneIds: ['a'] };
beforeEach(() => { vi.clearAllMocks(); __setShotSheetDepsForTests({ resolve: async () => ({ provider, selectedModel: 'm' }), run }); });

describe('proposeShotSheet', () => {
  // Catches the visible prompt preview actually calling a provider, or hiding what it would send (#11315).
  it('previews what would be sent without calling the provider', async () => {
    const result = await proposeShotSheet('p', { ...base, direction: 'to-prompts', preview: true, instruction: 'Darker' });
    expect(run).not.toHaveBeenCalled();
    expect(result.promptAdditions.map((entry) => entry.id)).toContain('shot-sheet-direction');
    for (const text of ['Frame A', 'Scared', 'Ben owns it', 'Darker']) expect(result.sentPrompt).toContain(text);
  });
  // Catches a sheet rewrite growing the prompt by keeping every earlier detail instead of restating the shot short.
  it('asks a sheet rewrite for a short, one-action prompt', async () => {
    const { sentPrompt } = await proposeShotSheet('p', { ...base, direction: 'to-prompts', preview: true });
    expect(sentPrompt).toContain(FRAME_PROMPT_WRITING);
    expect(sentPrompt).toContain(CLIP_PROMPT_WRITING);
    expect(sentPrompt).not.toContain('Keep every detail');
  });
  // Catches AI ticking Checked, inventing a camera, or proposing for a shot nobody asked about.
  it('drops Checked, an unknown camera and unasked shots from a backfill', async () => {
    run.mockResolvedValue({ text: JSON.stringify({ shots: [
      { sceneId: 'a', sheet: { cameraId: 'drone', location: 'Street' } },
      { sceneId: 'b', sheet: { location: 'Mall' } },
    ] }) });
    const { shots } = await proposeShotSheet('p', { ...base, direction: 'from-prompts' });
    expect(shots).toEqual([{ sceneId: 'a', sheet: { location: 'Street' } }]);
    run.mockResolvedValue({ text: JSON.stringify({ shots: [{ sceneId: 'a', sheet: { checked: true, location: 'Street', cameraId: 'vhs' } }] }) });
    const again = await proposeShotSheet('p', { ...base, direction: 'from-prompts' });
    expect(again.shots).toEqual([{ sceneId: 'a', sheet: { location: 'Street', cameraId: 'vhs' } }]);
  });
  // Catches a split dropping its general prompt, smuggling in the build-from-sheet switch, or keeping an invented camera.
  it('returns a split as sheet columns plus the general prompt left over', async () => {
    run.mockResolvedValue({ text: JSON.stringify({ shots: [{ sceneId: 'a', sheet: { cameraId: 'drone', promptFromSheet: true, location: 'Curb' }, generalPrompt: 'Faded tee' }] }) });
    const { shots, sentPrompt } = await proposeShotSheet('p', { ...base, direction: 'split' });
    expect(shots).toEqual([{ sceneId: 'a', sheet: { location: 'Curb' }, generalPrompt: 'Faded tee' }]);
    expect(sentPrompt).toContain('Option lists');
  });
  // Catches a prompt proposal losing a field, and a shot with no prompts counting as a proposal.
  it('returns prompt proposals and leaves out empty ones', async () => {
    run.mockResolvedValue({ text: JSON.stringify({ shots: [{ sceneId: 'a', prompt: 'New motion' }, { sceneId: 'a' }] }) });
    const { shots } = await proposeShotSheet('p', { ...base, direction: 'to-prompts' });
    expect(shots).toEqual([{ sceneId: 'a', prompt: 'New motion' }]);
  });
  // Catches tighten joining the two prompts into one, or being sent the sheet-writing instructions.
  it('tightens the frame and clip prompts apart with the short-prompt rules', async () => {
    const { sentPrompt } = await proposeShotSheet('p', { ...base, direction: 'tighten', preview: true });
    expect(sentPrompt).toContain('"framePrompt":"Frame A","prompt":"Motion A"');
    expect(sentPrompt).toContain('say each thing once');
    expect(sentPrompt).toContain(FRAME_PROMPT_WRITING);
    expect(sentPrompt).toContain(CLIP_PROMPT_WRITING);
    expect(sentPrompt).not.toContain('carries out the director');
    run.mockResolvedValue({ text: JSON.stringify({ shots: [{ sceneId: 'a', framePrompt: 'Short frame', prompt: 'Short clip' }] }) });
    const { shots } = await proposeShotSheet('p', { ...base, direction: 'tighten' });
    expect(shots).toEqual([{ sceneId: 'a', framePrompt: 'Short frame', prompt: 'Short clip' }]);
    // A blank field is the template echoed back, not a request to wipe that prompt.
    run.mockResolvedValue({ text: JSON.stringify({ shots: [{ sceneId: 'a', framePrompt: '', prompt: 'New clip' }] }) });
    expect((await proposeShotSheet('p', { ...base, direction: 'tighten' })).shots).toEqual([{ sceneId: 'a', prompt: 'New clip' }]);
  });
  // Catches a rewrite replacing a sheet-built still's general prompt, which the director split out by hand.
  it('keeps a sheet-built still\'s frame prompt out of a rewrite', async () => {
    const built = project.scenes[0];
    project.scenes[0] = { ...built, shotSheet: { ...built.shotSheet, promptFromSheet: true } };
    run.mockResolvedValue({ text: JSON.stringify({ shots: [{ sceneId: 'a', framePrompt: 'Replaced', prompt: 'New clip' }] }) });
    const { shots, sentPrompt } = await proposeShotSheet('p', { ...base, direction: 'tighten' });
    project.scenes[0] = built;
    expect(sentPrompt).toContain('"stillFromSheet":true');
    expect(shots).toEqual([{ sceneId: 'a', prompt: 'New clip' }]);
  });
  // Catches a stale client asking about a deleted shot, or unusable output reaching the review.
  it('refuses a missing shot and an unreadable reply', async () => {
    await expect(proposeShotSheet('p', { ...base, sceneIds: ['gone'], direction: 'to-prompts' })).rejects.toMatchObject({ status: 409 });
    run.mockResolvedValue({ text: 'not json' });
    await expect(proposeShotSheet('p', { ...base, direction: 'to-prompts' })).rejects.toMatchObject({ status: 502 });
  });
});

describe('shot sheet AI limits', () => {
  // Catches one request carrying a whole video.
  it('refuses an oversized batch', () => {
    const sceneIds = Array.from({ length: 16 }, (_, at) => `s${at}`);
    expect(shotSheetProposeSchema.safeParse({ providerId: 'p', direction: 'to-prompts', sceneIds }).success).toBe(false);
  });
  // Catches a backfill overwriting anything the director set, including Checked.
  it('fills only empty columns', () => {
    const { sheet, filled } = mergeShotSheetBackfill({ emotion: 'Mine', characters: [] }, { emotion: 'AI', characters: ['Ada'], checked: true, location: 'Mall' });
    expect(sheet).toEqual({ emotion: 'Mine', characters: ['Ada'], location: 'Mall' });
    expect(filled).toEqual(['characters', 'location']);
  });
});
