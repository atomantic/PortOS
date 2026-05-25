import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

// ── Mock SyncDetailDrawer ────────────────────────────────────────────────────
// Capture the props it receives so we can assert on them without rendering the
// full drawer (which would need a full mock tree for useSyncIntegrity, apis, etc.)
const mockDrawerProps = vi.fn();
vi.mock('../components/sync/SyncDetailDrawer', () => ({
  default: (props) => {
    mockDrawerProps(props);
    return (
      <div data-testid="sync-detail-drawer">
        <span data-testid="kind">{props.kind}</span>
        <span data-testid="record-id">{props.recordId}</span>
        <button onClick={props.onClose}>close</button>
      </div>
    );
  },
}));

import SyncView from './SyncView';

function renderSyncView({ path, route, kind, param, backPath }) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path={route} element={<SyncView kind={kind} param={param} backPath={backPath} />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('SyncView', () => {
  it('passes kind="universe" and decoded universeId to SyncDetailDrawer', () => {
    renderSyncView({
      path: '/universes/uni-abc/sync',
      route: '/universes/:universeId/sync',
      kind: 'universe',
      param: 'universeId',
      backPath: '/universes',
    });
    expect(screen.getByTestId('kind').textContent).toBe('universe');
    expect(screen.getByTestId('record-id').textContent).toBe('uni-abc');
  });

  it('passes kind="series" and decoded seriesId to SyncDetailDrawer', () => {
    renderSyncView({
      path: '/pipeline/series/ser-xyz/sync',
      route: '/pipeline/series/:seriesId/sync',
      kind: 'series',
      param: 'seriesId',
      backPath: '/pipeline',
    });
    expect(screen.getByTestId('kind').textContent).toBe('series');
    expect(screen.getByTestId('record-id').textContent).toBe('ser-xyz');
  });

  it('passes kind="mediaCollection" and decoded id to SyncDetailDrawer', () => {
    renderSyncView({
      path: '/media/collections/col-123/sync',
      route: '/media/collections/:id/sync',
      kind: 'mediaCollection',
      param: 'id',
      backPath: '/media/collections',
    });
    expect(screen.getByTestId('kind').textContent).toBe('mediaCollection');
    expect(screen.getByTestId('record-id').textContent).toBe('col-123');
  });

  it('decodes percent-encoded record ids from the URL', () => {
    renderSyncView({
      path: '/universes/my%20universe/sync',
      route: '/universes/:universeId/sync',
      kind: 'universe',
      param: 'universeId',
      backPath: '/universes',
    });
    expect(screen.getByTestId('record-id').textContent).toBe('my universe');
  });

  it('navigates to backPath when onClose is called', async () => {
    // Use a two-route setup so navigate has somewhere to go.
    const { getByRole, queryByTestId } = render(
      <MemoryRouter initialEntries={['/universes/uni-abc/sync']}>
        <Routes>
          <Route path="/universes" element={<div data-testid="universes-page">universes</div>} />
          <Route
            path="/universes/:universeId/sync"
            element={<SyncView kind="universe" param="universeId" backPath="/universes" />}
          />
        </Routes>
      </MemoryRouter>,
    );
    expect(queryByTestId('sync-detail-drawer')).toBeInTheDocument();
    fireEvent.click(getByRole('button', { name: /close/i }));
    expect(queryByTestId('sync-detail-drawer')).not.toBeInTheDocument();
    expect(screen.getByTestId('universes-page')).toBeInTheDocument();
  });
});
