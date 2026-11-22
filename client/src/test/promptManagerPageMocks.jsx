/**
 * Shared mock scaffold for the Prompt Manager suites: the page shell
 * (`pages/PromptManager.test.jsx`) and one suite per editor
 * (`components/prompts/{Stages,Variables,JobSkills,AgentSkills}Editor.test.jsx`).
 *
 * **Importing this module registers the mocks.** `vi.mock` is hoisted to the
 * top of this module, so the registrations run before this module's own import
 * of the page below, and the relative specifiers resolve to the same modules
 * the editors import (`src/test/../services/apiPrompts`). Suites drive the API
 * through the exported spies, which every mock delegates to at call time.
 *
 * Every suite mounts the real page through its real routes (`/prompts` and
 * `/prompts/:tab`), so the redirect, tab bar and editor all run as shipped.
 */

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

export const api = {
  getPrompts: vi.fn(),
  getPrompt: vi.fn(),
  getPromptUsage: vi.fn(),
  savePrompt: vi.fn(),
  previewPrompt: vi.fn(),
  deletePrompt: vi.fn(),
  createPrompt: vi.fn(),
  getPromptVariables: vi.fn(),
  createPromptVariable: vi.fn(),
  savePromptVariable: vi.fn(),
  deletePromptVariable: vi.fn(),
  getJobSkills: vi.fn(() => Promise.resolve({ skills: [] })),
  getJobSkill: vi.fn(() => Promise.resolve({})),
  saveJobSkill: vi.fn(),
  previewJobSkill: vi.fn(),
  getSkills: vi.fn(() => Promise.resolve({ skills: [], archived: [], quarantined: [] })),
  viewSkill: vi.fn(() => Promise.resolve({ content: '' })),
  editSkill: vi.fn(),
  getCuratorStatus: vi.fn(() => Promise.resolve({ config: { staleAfterDays: 14, archiveAfterDays: 30 }, counts: null, lastRun: null, job: null })),
  runCurator: vi.fn(),
  applySkillAction: vi.fn(),
  getSkillLedger: vi.fn(() => Promise.resolve({ entries: [] })),
  rollbackSkillLedgerEntry: vi.fn(),
};

vi.mock('../services/apiPrompts', () => Object.fromEntries(
  ['getPrompts', 'getPrompt', 'createPrompt', 'savePrompt', 'deletePrompt', 'previewPrompt', 'getPromptUsage',
    'getPromptVariables', 'createPromptVariable', 'savePromptVariable', 'deletePromptVariable',
    'getJobSkills', 'getJobSkill', 'saveJobSkill', 'previewJobSkill']
    .map((name) => [name, (...args) => api[name](...args)]),
));
vi.mock('../services/apiSkills', () => Object.fromEntries(
  ['getSkills', 'viewSkill', 'editSkill', 'getCuratorStatus', 'runCurator', 'applySkillAction', 'getSkillLedger', 'rollbackSkillLedgerEntry']
    .map((name) => [name, (...args) => api[name](...args)]),
));
vi.mock('../services/apiProviders', () => ({
  getProviders: vi.fn(() => Promise.resolve({ providers: [], activeProvider: null })),
}));
// useInstanceFeatures reads apiSystem.js directly, not the barrel (#16562).
vi.mock('../services/apiSystem.js', async (importOriginal) => ({
  ...await importOriginal(),
  getInstanceFeatures: vi.fn().mockResolvedValue({ features: [], groups: [] }),
}));
vi.mock('../components/ui/Toast', () => ({
  default: { success: vi.fn(), error: vi.fn() },
}));

// Imported after the registrations above so the page binds to the mocks.
const { default: PromptManager } = await import('../pages/PromptManager');
export const { default: toast } = await import('../components/ui/Toast');

export const STAGES = {
  'pipeline-prose-draft': { name: 'Pipeline — Prose Draft', description: 'Draft the prose' },
  'pipeline-comic-script': { name: 'Pipeline — Comic Book Script', description: 'Panels and balloons' },
  'creative-director-treatment': { name: 'Creative Director — Treatment', description: 'Treatment doc' },
  'brain-classifier': { name: 'Brain Classifier', description: 'Classify a thought' },
};

// The system-stage list is served, not mirrored client-side (#3314) — the page
// badges and filters exactly what GET /api/prompts names in `systemStages`.
export const SYSTEM_STAGES = ['brain-classifier'];

// Surfaces the live location so URL-driven selection can be asserted on.
const LocationProbe = () => {
  const { pathname, search } = useLocation();
  const navigate = useNavigate();
  return <>
    <div data-testid="location-pathname">{pathname}</div>
    <div data-testid="location-search">{search}</div>
    <button onClick={() => navigate(-1)}>History Back</button>
    <button onClick={() => navigate(1)}>History Forward</button>
  </>;
};

export const renderPage = async (entry = '/prompts/stages') => {
  const result = render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/prompts" element={<PromptManager />} />
        <Route path="/prompts/:tab" element={<PromptManager />} />
      </Routes>
      <LocationProbe />
    </MemoryRouter>,
  );
  await act(async () => {});
  return result;
};

export const currentSearch = () => screen.getByTestId('location-search').textContent;
export const currentPathname = () => screen.getByTestId('location-pathname').textContent;
export const promptTab = (name) => screen.getByRole('tab', { name });

// File-level defaults so every suite mounts against the same empty-ish page;
// individual suites override only what they assert on.
beforeEach(() => {
  api.getPrompts.mockReset().mockResolvedValue({ stages: STAGES, systemStages: SYSTEM_STAGES });
  api.getPromptVariables.mockReset().mockResolvedValue({ variables: {} });
  api.createPromptVariable.mockReset().mockResolvedValue({ success: true });
  api.savePromptVariable.mockReset().mockResolvedValue({ success: true });
  api.deletePromptVariable.mockReset().mockResolvedValue({ success: true });
  toast.success.mockReset();
  toast.error.mockReset();
});

// Below the split-pane width the selected editor leads and the catalogue moves
// behind a Drawer (#11142). happy-dom has no layout, so the page's measured
// content width is injected through a ResizeObserver stand-in. Call inside a
// `describe`.
export function withNarrowLayout(width = 500) {
  const realResizeObserver = globalThis.ResizeObserver;
  beforeEach(() => {
    globalThis.ResizeObserver = class {
      constructor(cb) { this.cb = cb; }
      observe() { this.cb([{ contentRect: { width } }]); }
      disconnect() {}
    };
  });
  afterEach(() => {
    globalThis.ResizeObserver = realResizeObserver;
  });
}

export const chooser = (noun) => screen.getByRole('button', { name: new RegExp(`Choose another ${noun}`) });

// Each public editor boundary rejects writes before a successful detail read,
// then restores intentional editing without changing server persistence rules.
// Shared by the Stages and Job Skills suites, whose editors both admit writes
// only after their detail read.
export function describeDetailAdmission({ kind, entry, detail, save, preview: previewApi, label, first, second, secondLabel, param }) {
  describe(`${kind} detail admission`, () => {
    const response = (text) => kind === 'stage'
      ? { name: 'Loaded stage', template: text, model: 'default', variables: [] }
      : { jobName: 'Loaded skill', content: text };
    const box = () => screen.getByLabelText(label);
    const saveButton = () => screen.getByRole('button', { name: /^Save$/ });
    const previewButton = () => screen.getByRole('button', { name: /^Preview$/ });

    beforeEach(() => {
      api.getPrompts.mockReset().mockResolvedValue({ stages: STAGES, systemStages: SYSTEM_STAGES });
      api.getJobSkills.mockReset().mockResolvedValue({ skills: [{ name: 'code-fixer' }, { name: 'doc-writer' }] });
      detail.mockReset();
      save.mockReset().mockResolvedValue({ success: true });
      previewApi.mockReset().mockResolvedValue({ preview: 'rendered' });
    });

    it('blocks pending and failed reads, exposes Retry, and permits editing only after hydration', async () => {
      let rejectRead;
      let resolveRetry;
      detail.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectRead = reject; }))
        .mockImplementationOnce(() => new Promise((resolve) => { resolveRetry = resolve; }));
      await renderPage(entry);
      expect(box().disabled).toBe(true);
      expect(saveButton().disabled).toBe(true);
      expect(previewButton().disabled).toBe(true);
      if (kind === 'stage') {
        expect(screen.getByLabelText('Model tier').disabled).toBe(true);
        expect(screen.getByLabelText('Timeout override (ms)').disabled).toBe(true);
        expect(screen.getByRole('button', { name: 'Tier' }).disabled).toBe(true);
      }
      fireEvent.click(saveButton());
      fireEvent.click(previewButton());
      expect(save).not.toHaveBeenCalled();
      expect(previewApi).not.toHaveBeenCalled();

      await act(async () => rejectRead(new Error('503 unavailable')));
      expect(screen.getByRole('alert').textContent).toContain('503 unavailable');
      expect(box().disabled).toBe(true);
      fireEvent.click(saveButton());
      expect(save).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
      expect(saveButton().disabled).toBe(true);
      await act(async () => resolveRetry(response('Original content')));
      expect(screen.queryByRole('alert')).toBeNull();
      expect(box().disabled).toBe(false);
      // Clearing a loaded stage is deliberate and remains a valid write.
      fireEvent.change(box(), { target: { value: kind === 'stage' ? '' : 'Edited skill' } });
      fireEvent.click(saveButton());
      await waitFor(() => expect(save).toHaveBeenCalled());
      if (kind === 'stage') expect(save).toHaveBeenCalledWith(first, expect.objectContaining({ template: '', provider: null }), { silent: true });
      else expect(save).toHaveBeenCalledWith(first, 'Edited skill', { silent: true });
    });

    it('revokes admission on list and history navigation and ignores superseded detail responses', async () => {
      let resolveSecond;
      let resolveBack;
      let resolveForward;
      detail.mockResolvedValueOnce(response('First content'))
        .mockImplementationOnce(() => new Promise((resolve) => { resolveSecond = resolve; }))
        .mockImplementationOnce(() => new Promise((resolve) => { resolveBack = resolve; }))
        .mockImplementationOnce(() => new Promise((resolve) => { resolveForward = resolve; }));
      await renderPage(entry);
      await screen.findByDisplayValue('First content');
      fireEvent.click(screen.getByText(secondLabel));
      expect(currentSearch()).toContain(`${param}=${second}`);
      expect(box().value).toBe('');
      expect(box().disabled).toBe(true);
      expect(saveButton().disabled).toBe(true);
      fireEvent.click(screen.getByRole('button', { name: 'History Back' }));
      expect(currentSearch()).toContain(`${param}=${first}`);
      expect(box().disabled).toBe(true);
      await act(async () => resolveSecond(response('Stale second content')));
      expect(box().value).toBe('');
      expect(saveButton().disabled).toBe(true);
      await act(async () => resolveBack(response('Fresh first content')));
      expect(box().value).toBe('Fresh first content');
      expect(saveButton().disabled).toBe(false);
      fireEvent.click(screen.getByRole('button', { name: 'History Forward' }));
      expect(currentSearch()).toContain(`${param}=${second}`);
      expect(box().disabled).toBe(true);
      expect(previewButton().disabled).toBe(true);
      await act(async () => resolveForward(response('Fresh second content')));
      expect(box().value).toBe('Fresh second content');
      expect(box().disabled).toBe(false);
    });
  });
}

// A stage family's disclosure header, named "<Family>, <n> stage(s)".
export const groupHeader = (label) => screen.getByRole('button', { name: new RegExp(`^${label}, \\d+ stages?$`, 'i') });
