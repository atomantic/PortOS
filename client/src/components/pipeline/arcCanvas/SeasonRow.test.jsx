import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { listPipelineIssues, startPipelineVolumeBeats } from '../../../services/apiPipeline.js';
import { lastEventSource, MockEventSource } from '../../../test/mockEventSource';
import toast from '../../ui/Toast';
import SeasonRow from './SeasonRow.jsx';

vi.mock('../../../services/apiPipeline.js', async (importOriginal) => ({
  ...await importOriginal(),
  startPipelineVolumeBeats: vi.fn(),
  listPipelineIssues: vi.fn(),
}));
vi.mock('../../ui/Toast');
vi.mock('./IssueRow.jsx', () => ({ default: () => null }));
vi.mock('./VolumeCoverLiveUpdates.jsx', () => ({ default: () => null }));
vi.mock('./VolumeCoversPanel.jsx', () => ({ default: () => null }));

const series = { id: 'series-a' };
const season = { id: 'season-a', number: 1 };
const issues = [{ id: 'issue-a' }];
const generateButton = () => screen.getByRole('button', { name: 'Generate beat sheets' });

function renderSeason() {
  const props = { series, season, seasons: [season], issues, onIssuesUpdate: vi.fn() };
  return { ...render(<SeasonRow {...props} />), props };
}

async function startRun(runId) {
  startPipelineVolumeBeats.mockResolvedValueOnce({ runId });
  fireEvent.click(generateButton());
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Regenerate all' })));
  return lastEventSource();
}

beforeEach(() => {
  vi.resetAllMocks();
  MockEventSource.reset();
  vi.stubGlobal('EventSource', MockEventSource);
  listPipelineIssues.mockResolvedValue(issues);
});

afterEach(() => vi.unstubAllGlobals());

describe('SeasonRow beat-sheet runs', () => {
  it('tracks a second run on the same URL without replaying the previous terminal frame', async () => {
    const { props } = renderSeason();
    const first = await startRun('run-1');
    await act(async () => first.emit({ type: 'complete', runId: 'run-1', generated: 1 }));
    expect(generateButton()).not.toBeDisabled();
    expect(toast.success).toHaveBeenCalledWith('Volume 1 beat sheets — 1 generated');

    const second = await startRun('run-2');
    expect(second).not.toBe(first);
    expect(second.url).toBe(first.url);
    expect(second.closed).toBe(false);
    expect(generateButton()).toBeDisabled();
    act(() => second.emit({ type: 'issue:start', ordinal: 1, total: 2, issueNumber: 1 }));
    expect(screen.getByText('Generating 1/2 — #1')).toBeInTheDocument();
    expect(toast.success).toHaveBeenCalledTimes(1);
    expect(listPipelineIssues).toHaveBeenCalledTimes(1);

    await act(async () => second.emit({ type: 'complete', runId: 'run-2', generated: 2 }));
    expect(toast.success).toHaveBeenLastCalledWith('Volume 1 beat sheets — 2 generated');
    expect(props.onIssuesUpdate).toHaveBeenCalledTimes(2);
    expect(generateButton()).not.toBeDisabled();
  });

  it.each(['404', 'dropped after progress', 'mismatched terminal frame'])('recovers after %s', async (closure) => {
    const { props } = renderSeason();
    const stream = await startRun('run-1');
    if (closure === 'dropped after progress') {
      act(() => stream.emit({ type: 'start', runId: 'run-1', total: 1 }));
      act(() => stream.fail(MockEventSource.CONNECTING));
      expect(generateButton()).toBeDisabled();
    }
    await act(async () => {
      if (closure === 'mismatched terminal frame') {
        stream.emit({ type: 'complete', runId: 'old-run', generated: 5 });
      } else {
        stream.fail();
      }
    });
    expect(generateButton()).not.toBeDisabled();
    expect(listPipelineIssues).toHaveBeenCalledExactlyOnceWith(series.id);
    expect(props.onIssuesUpdate).toHaveBeenCalledExactlyOnceWith(issues);
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it.each(['unmount', 'series switch'])('drops a pending refresh after %s', async (change) => {
    const { props, rerender, unmount } = renderSeason();
    const pending = Promise.withResolvers();
    listPipelineIssues.mockReturnValueOnce(pending.promise);
    const stream = await startRun('run-1');
    act(() => stream.fail());
    expect(listPipelineIssues).toHaveBeenCalledExactlyOnceWith(series.id);

    const nextCallback = vi.fn();
    if (change === 'unmount') unmount();
    else rerender(<SeasonRow {...props} series={{ id: 'series-b' }} onIssuesUpdate={nextCallback} />);
    await act(async () => pending.resolve(issues));
    expect(props.onIssuesUpdate).not.toHaveBeenCalled();
    expect(nextCallback).not.toHaveBeenCalled();
  });
});
