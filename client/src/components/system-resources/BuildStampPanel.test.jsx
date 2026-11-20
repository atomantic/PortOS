import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';

const api = vi.hoisted(() => ({ getSystemBuild: vi.fn() }));
vi.mock('../../services/apiSystem.js', () => ({ getSystemBuild: api.getSystemBuild }));

const serverBuild = (overrides = {}) => ({
  commit: 'abc1234567890abcdef1234567890abcdef12345',
  shortCommit: 'abc1234',
  branch: 'main',
  dirty: false,
  ...overrides,
});

// `__BUILD_STAMP__` is a Vite define read once at module scope, and the trusted
// form is additionally gated on the server-injected build-id meta tag — so both
// have to be in place BEFORE the module graph loads.
async function renderPanel({ stamp, served = 'aaaa1111bbbb', build = serverBuild(), ...props } = {}) {
  vi.resetModules();
  vi.unstubAllGlobals();
  if (stamp !== undefined) vi.stubGlobal('__BUILD_STAMP__', stamp);
  document.head.innerHTML = served
    ? `<meta name="portos-build-id" content="${served}">`
    : '';
  api.getSystemBuild.mockResolvedValue(build);
  const Panel = (await import('./BuildStampPanel.jsx')).default;
  const result = render(<Panel {...props} />);
  await waitFor(() => expect(api.getSystemBuild).toHaveBeenCalled());
  return result;
}

afterEach(() => {
  vi.unstubAllGlobals();
  document.head.innerHTML = '';
  api.getSystemBuild.mockReset();
});

describe('BuildStampPanel', () => {
  it('reads the stamp from its own route, not the peer-scraped health payload', async () => {
    await renderPanel();

    expect(api.getSystemBuild).toHaveBeenCalledWith({ silent: true });
    await waitFor(() => expect(screen.getByText('abc1234 · main')).toBeInTheDocument());
  });

  it('flags a stale bundle when the page and the API were built from different commits', async () => {
    await renderPanel({ stamp: { commit: 'def5678', branch: 'main' } });

    await waitFor(() => expect(screen.getByText(/stale relative to the server/i)).toBeInTheDocument());
    expect(screen.getByText('def5678')).toBeInTheDocument();
    expect(screen.getByText('abc1234')).toBeInTheDocument();
  });

  it('confirms agreement only when BOTH trees are confirmed clean', async () => {
    await renderPanel({ stamp: { commit: 'abc1234', branch: 'main', dirty: false } });

    await waitFor(() => expect(screen.getByText(/what you are looking at is the code that is running/i)).toBeInTheDocument());
  });

  it('does not claim the running code matches when the server tree has uncommitted changes', async () => {
    // Commit-only comparison cannot see working-tree edits — asserting a match
    // here would be a false assurance in the exact session this panel ends.
    await renderPanel({
      stamp: { commit: 'abc1234', branch: 'main', dirty: false },
      build: serverBuild({ dirty: true }),
    });

    await waitFor(() => expect(screen.getByText(/the server tree had uncommitted changes/i)).toBeInTheDocument());
    expect(screen.queryByText(/what you are looking at is the code that is running/i)).not.toBeInTheDocument();
  });

  it('does not claim agreement when the BUNDLE was built from a dirty tree', async () => {
    // A dist built from edited sources carries its parent's clean commit, so the
    // commit ids match while the bundle contains code that was never committed.
    await renderPanel({
      stamp: { commit: 'abc1234', branch: 'main', dirty: true },
      build: serverBuild({ dirty: false }),
    });

    await waitFor(() => expect(screen.getByText(/this bundle had uncommitted changes/i)).toBeInTheDocument());
    expect(screen.queryByText(/what you are looking at is the code that is running/i)).not.toBeInTheDocument();
  });

  it('names both trees when both were dirty', async () => {
    await renderPanel({
      stamp: { commit: 'abc1234', branch: 'main', dirty: true },
      build: serverBuild({ dirty: true }),
    });

    await waitFor(() => expect(screen.getByText(/the server tree and this bundle had uncommitted changes/i)).toBeInTheDocument());
  });

  it('says the cleanliness check did not run rather than claiming agreement', async () => {
    // `null` is "we could not tell" — never rendered as clean.
    await renderPanel({
      stamp: { commit: 'abc1234', branch: 'main', dirty: null },
      build: serverBuild({ dirty: null }),
    });

    await waitFor(() => expect(screen.getByText(/could not be checked/i)).toBeInTheDocument());
    expect(screen.queryByText(/what you are looking at is the code that is running/i)).not.toBeInTheDocument();
  });

  it('never claims agreement when the bundle stamp is unavailable', async () => {
    await renderPanel();

    await waitFor(() => expect(screen.getByText(/commit unknown on at least one side/i)).toBeInTheDocument());
    expect(screen.queryByText(/what you are looking at is the code that is running/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/stale relative to the server/i)).not.toBeInTheDocument();
  });

  it('distrusts the bundle stamp under the dev server, where it is frozen at startup', async () => {
    // No injected meta tag = Vite is serving index.html. The define still holds
    // the commit the dev server STARTED at while HMR serves everything since.
    await renderPanel({ stamp: { commit: 'def5678', branch: 'main' }, served: null });

    await waitFor(() => expect(screen.getByText(/no built bundle to compare/i)).toBeInTheDocument());
    expect(screen.queryByText(/stale relative to the server/i)).not.toBeInTheDocument();
    expect(screen.queryByText('def5678')).not.toBeInTheDocument();
  });

  it('renders "unknown" rather than blank rows when the server has no git metadata', async () => {
    await renderPanel({ build: { commit: null, shortCommit: null, branch: null, dirty: null } });

    await waitFor(() => expect(screen.getAllByText('unknown').length).toBeGreaterThan(0));
  });

  it('labels the server row as a boot-time snapshot, not a live tree read', async () => {
    await renderPanel({ build: serverBuild({ dirty: true }), uptimeFormatted: '3h 12m' });

    await waitFor(() => expect(screen.getByText(/uncommitted changes/)).toBeInTheDocument());
    expect(screen.getByText('at start · up 3h 12m')).toBeInTheDocument();
  });

  it('blames the endpoint, not the checkout, when the build fetch fails', async () => {
    // An older server has no /api/system/build at all. Rendering "no git
    // metadata" there would name a cause the panel never established.
    vi.resetModules();
    document.head.innerHTML = '';
    api.getSystemBuild.mockRejectedValue(new Error('404'));
    const Panel = (await import('./BuildStampPanel.jsx')).default;

    render(<Panel />);

    expect(screen.getByText('Running build')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText(/may be running a version without this endpoint/i)).toBeInTheDocument());
    expect(screen.queryByText(/no git metadata/i)).not.toBeInTheDocument();
  });

  it('says it is still checking rather than claiming missing git metadata', async () => {
    // The pre-fetch state is not evidence about the checkout.
    vi.resetModules();
    document.head.innerHTML = '';
    let release;
    api.getSystemBuild.mockReturnValue(new Promise((resolve) => { release = resolve; }));
    const Panel = (await import('./BuildStampPanel.jsx')).default;

    render(<Panel />);

    expect(screen.getByText(/checking which build is running/i)).toBeInTheDocument();
    expect(screen.queryByText(/no git metadata/i)).not.toBeInTheDocument();

    // Settle the pending fetch inside act, or its state update lands after the
    // test and the suite treats the act warning as a failure.
    await act(async () => { release(serverBuild()); });
    expect(screen.getByText('abc1234 · main')).toBeInTheDocument();
  });
});
