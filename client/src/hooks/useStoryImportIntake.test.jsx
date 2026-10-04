import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import useStoryImportIntake from './useStoryImportIntake';
import { analyzeImport, commitImport, createStorySession } from '../services/api';

vi.mock('../services/api', () => ({
  analyzeImport: vi.fn(),
  commitImport: vi.fn(),
  retryImporterIssues: vi.fn(),
  createStorySession: vi.fn(),
}));
vi.mock('../components/ui/Toast', () => ({
  default: { error: vi.fn(), warning: vi.fn(), info: vi.fn(), success: vi.fn() },
}));

const IMPORT_ID = `imp-${'a'.repeat(32)}`;
const analysis = (importSession = null) => ({
  universe: { id: 'uni-1', name: 'Example Universe' },
  series: { id: 'ser-1', name: 'Example Series' },
  importId: IMPORT_ID,
  importSession,
  canonPreview: { characters: [{ name: 'Aria' }], places: [], objects: [] },
  arcPreview: { logline: 'A logline.', summary: 'A summary.', shape: 'man-in-hole' },
  seasonsPreview: [{ number: 1, title: 'S1' }],
  issueProposals: [{ title: 'Cold Iron', arcPosition: 1 }],
});

// A freshly mounted hook is what a reload leaves behind: no committed flag, no
// persisted-arc flag, no preview. Only the manuscript is re-entered.
async function reanalyze(importSession) {
  analyzeImport.mockResolvedValue(analysis(importSession));
  const onCreated = vi.fn();
  const hook = renderHook(() => useStoryImportIntake(onCreated));
  act(() => hook.result.current.patch({
    universeName: 'Example Universe', seriesName: 'Example Series', source: 'Example manuscript text.',
  }));
  await act(async () => { await hook.result.current.analyze(); });
  return { hook, onCreated };
}

describe('useStoryImportIntake — server import session (#9943)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createStorySession.mockResolvedValue({ id: 'story-1' });
  });

  it('sends the import id analyze returned, with the full payload on a first commit', async () => {
    const { hook, onCreated } = await reanalyze(null);
    commitImport.mockResolvedValue({ createdIssueIds: ['iss-1'] });

    await act(async () => { await hook.result.current.importAndBuild(); });

    const payload = commitImport.mock.calls[0][0];
    expect(payload.importId).toBe(IMPORT_ID);
    expect(payload.arc).toMatchObject({ shape: 'man-in-hole' });
    expect(onCreated).toHaveBeenCalledWith({ id: 'story-1' });
  });

  it('resumes at session creation after a reload when the server says the import committed', async () => {
    const { hook, onCreated } = await reanalyze({ status: 'committed', createdIssueIds: ['iss-1'] });

    await act(async () => { await hook.result.current.importAndBuild(); });

    expect(commitImport).not.toHaveBeenCalled();
    expect(createStorySession).toHaveBeenCalledOnce();
    expect(onCreated).toHaveBeenCalledWith({ id: 'story-1' });
  });

  it('resumes a committed import even when the re-analysis proposed no issues', async () => {
    analyzeImport.mockResolvedValue({
      ...analysis({ status: 'committed', createdIssueIds: ['iss-1'] }),
      issueProposals: [],
      issueSplitFailed: true,
    });
    const onCreated = vi.fn();
    const hook = renderHook(() => useStoryImportIntake(onCreated));
    act(() => hook.result.current.patch({
      universeName: 'Example Universe', seriesName: 'Example Series', source: 'Example manuscript text.',
    }));
    await act(async () => { await hook.result.current.analyze(); });

    await act(async () => { await hook.result.current.importAndBuild(); });

    expect(commitImport).not.toHaveBeenCalled();
    expect(onCreated).toHaveBeenCalled();
  });

  it('drops the arc from the retry after a reload when the server kept it from a failed commit', async () => {
    const { hook } = await reanalyze({ status: 'arc-persisted', createdIssueIds: [] });
    commitImport.mockResolvedValue({ createdIssueIds: ['iss-1'] });

    await act(async () => { await hook.result.current.importAndBuild(); });

    const payload = commitImport.mock.calls[0][0];
    expect(payload).toMatchObject({ importId: IMPORT_ID, arc: null, seasons: [] });
    expect(payload.canonSelections).toEqual({ characters: [], places: [], objects: [] });
  });
});
