import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import PersistentMindVisibilityPanel from './PersistentMindVisibilityPanel';

const renderPanel = (visibility) => render(
  <MemoryRouter>
    <PersistentMindVisibilityPanel visibility={visibility} loading={false} onRefresh={vi.fn()} />
  </MemoryRouter>,
);

const blockedVisibility = (overrides = {}) => ({
  capturedAt: '2026-08-27T12:00:00.000Z',
  freshness: { state: 'fresh' },
  readiness: 'blocked',
  workspaces: [{
    appId: 'example-app',
    appName: 'Example App',
    readiness: 'blocked',
    preflight: {
      warnings: [
        { code: 'workspace-engines-unavailable', check: 'engines', severity: 'warning', message: 'The required engine is incompatible.' },
        { code: 'workspace-reviewers-unavailable', check: 'reviewers', severity: 'warning', message: 'A required reviewer is unavailable.' },
      ],
    },
  }],
  ...overrides,
});

describe('PersistentMindVisibilityPanel', () => {
  it('makes missing world access actionable and shows release context without enabling anything', () => {
    renderPanel({ orientation: {
      eidoverse: { status: 'offline', canBuild: false, connected: false },
      release: { status: 'available', version: '1.0.0', highlights: ['Example release improvement'] },
      modelPolicy: { continuity: 'Identity and memories persist.' },
    } });
    expect(screen.getByRole('region', { name: 'Mind orientation' })).toHaveTextContent('World building off');
    expect(screen.getByRole('link', { name: 'Open Eidoverse' })).toHaveAttribute('href', '/eidoverse');
    expect(screen.getByRole('link', { name: 'Configure mind tools' })).toHaveAttribute('href', '/cos/mind?panel=tools');
    expect(screen.getByRole('link', { name: 'Change thinking model' })).toHaveAttribute('href', '/cos/mind?panel=settings');
    expect(screen.getByText('Example release improvement')).toBeInTheDocument();
  });

  it('turns a blocked snapshot into direct repair and permission actions', () => {
    renderPanel(blockedVisibility());

    expect(screen.getByRole('alert')).toHaveTextContent('Delegated work is blocked');
    expect(screen.getByRole('link', { name: /manage permissions/i })).toHaveAttribute('href', '/cos/tools');
    expect(screen.getByRole('link', { name: /managed apps/i })).toHaveAttribute('href', '/apps');
    expect(screen.getByRole('link', { name: /manage reviewers/i })).toHaveAttribute('href', '/models/code-reviewers');
    expect(screen.getByRole('link', { name: /open app settings/i })).toHaveAttribute('href', '/apps/example-app/overview?edit=1&appTab=general');
  });

  it('links submodule blockers to the affected app instead of hiding the cause', () => {
    renderPanel(blockedVisibility({
      workspaces: [{
        appId: 'example-app',
        appName: 'Example App',
        readiness: 'blocked',
        preflight: {
          warnings: [{ code: 'workspace-submodules-unavailable', check: 'submodules', severity: 'warning', message: 'Submodules need initialization.' }],
        },
      }],
    }));

    expect(screen.getByRole('link', { name: /manage submodules/i })).toHaveAttribute('href', '/apps/example-app/submodules');
  });

  it('does not present repair actions for a ready workspace', () => {
    renderPanel({
      ...blockedVisibility(),
      readiness: 'ready',
      workspaces: [{
        appId: 'example-app',
        appName: 'Example App',
        readiness: 'ready',
        preflight: { warnings: [] },
      }],
    });

    expect(screen.queryByRole('link', { name: /manage permissions/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /open app settings/i })).not.toBeInTheDocument();
  });
});
