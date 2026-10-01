/**
 * Where you post (#9287): every platform is a toggle with an optional account,
 * and each row shows how posts there were received across projects.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import PublishPlatformsPanel from './PublishPlatformsPanel.jsx';
import PublishKitPanel from './PublishKitPanel.jsx';

vi.mock('../../hooks/useProviderModels.js', () => ({
  default: () => ({ providers: [], selectedProviderId: '', selectedModel: '', availableModels: [], setSelectedProviderId: vi.fn(), setSelectedModel: vi.fn() }),
}));

const publishing = (over = {}) => ({
  platforms: { x: { enabled: true, account: 'antic' }, reddit: { enabled: false, account: null } },
  history: { reddit: { posts: 2, good: 0, mixed: 0, poor: 2, notes: [{ notes: 'poorly received', reception: 'poor' }] } },
  setPlatform: vi.fn(async () => null),
  ...over,
});

describe('PublishPlatformsPanel (#9287)', () => {
  it('toggles platforms and saves an account on blur', () => {
    const p = publishing();
    render(<PublishPlatformsPanel publishing={p} />);
    const reddit = screen.getByRole('checkbox', { name: 'Reddit' });
    expect(reddit).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'X thread' })).toBeChecked();
    fireEvent.click(reddit);
    expect(p.setPlatform).toHaveBeenCalledWith('reddit', { enabled: true });
    const account = screen.getByLabelText('X thread account');
    expect(account).toHaveValue('antic');
    fireEvent.change(account, { target: { value: 'gof_music' } });
    fireEvent.blur(account);
    expect(p.setPlatform).toHaveBeenCalledWith('x', { account: 'gof_music' });
    expect(screen.getByLabelText('Reddit account')).toBeDisabled();
  });

  it('shows what earlier posts taught', () => {
    render(<PublishPlatformsPanel publishing={publishing()} />);
    expect(screen.getByText('2 posts · 2 poor')).toBeInTheDocument();
    expect(screen.getByText('Last note: poorly received')).toBeInTheDocument();
    expect(screen.getAllByText('No posts yet').length).toBeGreaterThan(0);
  });

  it('renders nothing until the platforms load', () => {
    const { container } = render(<PublishPlatformsPanel publishing={publishing({ platforms: null })} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('PublishKitPanel copy per platform (#9287)', () => {
  const kitHook = { building: false, progress: 0, build: vi.fn(), drafting: false, saving: false, draftCopy: vi.fn(), saveCopy: vi.fn(), selectThumbnail: vi.fn() };
  const project = { id: 'mv-1', renderHistoryId: 'rh', publishKit: { copy: { youtube: { title: 'T' }, reddit: { title: 'R' } }, copyDraftedAt: 'x' } };

  it('shows copy only for enabled platforms (YouTube too when Suno is on)', () => {
    render(<PublishKitPanel project={project} publishKit={kitHook} enabledTargets={['suno', 'x']} />);
    expect(screen.getByText('YouTube', { selector: 'legend' })).toBeInTheDocument();
    expect(screen.getByText('X', { selector: 'legend' })).toBeInTheDocument();
    expect(screen.queryByText('Reddit', { selector: 'legend' })).toBeNull();
  });

  it('holds the copy draft until a platform is on', () => {
    render(<PublishKitPanel project={project} publishKit={kitHook} enabledTargets={[]} />);
    expect(screen.getByRole('button', { name: /Redraft copy/ })).toBeDisabled();
  });
});
