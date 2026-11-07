import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, useLocation, useNavigate } from 'react-router';
import socket from '../services/socket';
vi.mock('../services/socket', async () => {
  const { EventEmitter } = await import('events');
  return { default: new EventEmitter() };
});
const api = vi.hoisted(() => ({ getNativeUsageAccounts: vi.fn(), updateNativeUsageAccounts: vi.fn(), getNativeUsageMatrix: vi.fn() }));
vi.mock('../services/api', () => api);
import NativeUsageOverview from '../components/usage/NativeUsageOverview';
import { getNativeUsageAccounts, updateNativeUsageAccounts } from '../services/apiSystem';
const local = 'a'.repeat(32);
const peer = 'b'.repeat(32);
const missing = 'c'.repeat(32);
const revision = '1'.repeat(64);
const nextRevision = '2'.repeat(64);
const retained = (family, accountLabel = 'example-subscription', members = [local]) => ({ family, accountLabel, members, historyScope: 'operator-confirmed-retained-history' });
const model = (selections = [], extra = {}) => ({ revision, selections,
  participants: [{ participantKey: local, kind: 'local', status: 'configured' }, { participantKey: peer, kind: 'peer', status: 'configured' }],
  inventory: { status: 'complete', maxPeers: 64 }, ...extra });
function Location() {
  const navigate = useNavigate();
  return <><output aria-label="Location">{useLocation().search}</output>
    <button type="button" onClick={() => navigate(-1)}>Back</button><button type="button" onClick={() => navigate(1)}>Forward</button>
    <button type="button" onClick={() => navigate('?nativeScope=fleet')}>Leave editor for fleet</button></>;
}
const show = (path = '/devtools/usage') => render(<MemoryRouter initialEntries={[path]}><NativeUsageOverview /><Location /></MemoryRouter>);
const drawer = () => screen.getByRole('dialog', { name: 'Native account selections' });
const editor = () => within(drawer());
const open = async () => {
  fireEvent.click(screen.getByRole('button', { name: 'Edit account selections' }));
  await editor().findByRole('button', { name: 'Add account' });
};
const tab = label => fireEvent.click(editor().getByRole('tab', { name: label, exact: true }));
const add = () => fireEvent.click(editor().getByRole('button', { name: 'Add account' }));
const label = (value, index = 0) => fireEvent.change(editor().getAllByLabelText('Opaque account label')[index], { target: { value } });
const member = (name = /This instance/, index = 0) => fireEvent.click(editor().getAllByRole('checkbox', { name })[index]);
const acknowledge = (index = 0) => fireEvent.click(editor().getAllByRole('checkbox', { name: /I confirm the retained history/ })[index]);
const save = () => fireEvent.click(editor().getByRole('button', { name: 'Save selections' }));
const read = () => fireEvent.click(screen.getByRole('button', { name: 'Read native sources' }));
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
beforeEach(() => {
  vi.clearAllMocks();
  api.getNativeUsageAccounts.mockResolvedValue(model());
  api.updateNativeUsageAccounts.mockImplementation(async body => model(body.selections, { revision: nextRevision }));
  api.getNativeUsageMatrix.mockResolvedValue({ selectionRevision: revision, providers: [{ family: 'codex', status: 'available', totals: { lifetimeTokens: 123456 } }], families: [] });
});
afterEach(() => vi.restoreAllMocks());

describe('native account selection editor', () => {
  it('saves distinct explicit accounts for all four providers without reading sources and keeps draft state across URL tabs', async () => {
    show('?nativeScope=fleet');
    await open();
    expect(api.getNativeUsageAccounts).toHaveBeenCalledExactlyOnceWith({ silent: true });
    expect(editor().getByText(/No Codex accounts selected/)).toBeInTheDocument();
    expect(editor().getByRole('button', { name: 'Save selections' })).toBeDisabled();
    add(); label('example-codex'); member();
    expect(editor().getByLabelText('Authoritative Codex snapshot')).toHaveValue('');
    save();
    expect(await editor().findByRole('alert')).toHaveTextContent('Choose exactly one selected member');
    fireEvent.change(editor().getByLabelText('Authoritative Codex snapshot'), { target: { value: local } });
    for (const [family, name] of [['claude', 'Claude Code'], ['grok', 'Grok'], ['agy', 'Antigravity']]) {
      tab(name); add(); label(`example-${family}`); member();
      expect(editor().getByRole('checkbox', { name: /I confirm/ })).not.toBeChecked();
      acknowledge();
    }
    tab('Claude Code');
    expect(editor().getByLabelText('Opaque account label')).toHaveValue('example-claude');
    expect(editor().getByRole('checkbox', { name: /I confirm/ })).toBeChecked();
    add(); label('another-claude', 1); member(/Peer/, 1); acknowledge(1);
    expect(screen.getByLabelText('Location')).toHaveTextContent('nativeAccountTab=claude');
    save();
    expect(await editor().findByText(/Selections saved locally/)).toBeInTheDocument();
    expect(api.updateNativeUsageAccounts).toHaveBeenCalledExactlyOnceWith({ expectedRevision: revision, selections: [
      { family: 'codex', accountLabel: 'example-codex', members: [local], authoritativeParticipant: local },
      retained('claude', 'example-claude'), retained('grok', 'example-grok'), retained('agy', 'example-agy'), retained('claude', 'another-claude', [peer]),
    ] }, { silent: true });
    expect(api.getNativeUsageAccounts).toHaveBeenCalledTimes(1);
    expect(api.getNativeUsageMatrix).not.toHaveBeenCalled();
    expect(editor().getByRole('button', { name: 'Save selections' })).toBeDisabled();
    label('updated-claude');
    expect(editor().getAllByRole('checkbox', { name: /I confirm/ })[0]).not.toBeChecked();
    acknowledge(); save();
    await waitFor(() => expect(api.updateNativeUsageAccounts).toHaveBeenCalledTimes(2));
    expect(api.updateNativeUsageAccounts.mock.calls[1][0].expectedRevision).toBe(nextRevision);
    await editor().findByText(/Selections saved locally/);
  });

  it('validates inactive provider rows, duplicate labels/members, and renewed retained-history acknowledgment', async () => {
    show('?nativeAccounts=edit&nativeAccountTab=grok');
    await editor().findByRole('button', { name: 'Add account' });
    add(); label('first'); member();
    tab('Antigravity'); save();
    expect(editor().getByRole('tab', { name: 'Grok' })).toHaveAttribute('aria-selected', 'true');
    expect(editor().getByRole('alert')).toHaveTextContent('Confirm that the selected retained history');
    acknowledge(); add(); label('first', 1); member(/Peer/, 1); acknowledge(1); save();
    expect(editor().getByRole('alert')).toHaveTextContent('Account labels must be distinct');
    label('second', 1); member(/This instance/, 1); acknowledge(1); save();
    expect(editor().getByRole('alert')).toHaveTextContent('only one account per provider');
    fireEvent.click(editor().getByRole('button', { name: 'Remove account 2' }));
    member(/Peer/);
    expect(editor().getByRole('checkbox', { name: /I confirm/ })).not.toBeChecked();
    expect(api.updateNativeUsageAccounts).not.toHaveBeenCalled();
    expect(api.getNativeUsageMatrix).not.toHaveBeenCalled();
  });

  it('keeps missing saved members visible without inventing inventory or clearing their saved acknowledgment', async () => {
    api.getNativeUsageAccounts.mockResolvedValue(model([retained('agy', 'example-missing', [local, missing])], {
      participants: [...model().participants, { participantKey: missing, kind: 'unavailable', status: 'not-configured' }],
      inventory: { status: 'truncated', maxPeers: 64 },
    }));
    show('?nativeAccounts=edit&nativeAccountTab=agy');
    expect(await editor().findByRole('checkbox', { name: /Missing saved member/ })).toBeChecked();
    expect(editor().getByText(/Configured inventory is limited to 64 peers/)).toBeInTheDocument();
    expect(editor().getByRole('checkbox', { name: /I confirm/ })).toBeChecked();
    member(/Missing saved member/);
    expect(editor().getByRole('checkbox', { name: /Missing saved member/ })).toBeEnabled();
    expect(editor().getByRole('checkbox', { name: /I confirm/ })).not.toBeChecked();
    acknowledge(); save();
    await editor().findByText(/Selections saved locally/);
    expect(api.updateNativeUsageAccounts.mock.calls[0][0].selections[0].members).toEqual([local]);
  });

  it('fails closed on invalid saved settings, retries without creating empty selections, and retains drafts after save failure', async () => {
    api.getNativeUsageAccounts.mockRejectedValueOnce(Object.assign(new Error('Invalid'), { status: 503 }));
    show('?nativeAccounts=edit');
    expect(await editor().findByRole('alert')).toHaveTextContent('They have not been replaced with an empty selection');
    expect(editor().queryByRole('button', { name: 'Add account' })).not.toBeInTheDocument();
    expect(editor().getByRole('button', { name: 'Save selections' })).toBeDisabled();
    fireEvent.click(editor().getByRole('button', { name: 'Retry loading selections' }));
    await editor().findByRole('button', { name: 'Add account' });
    tab('Claude Code'); add(); label('example-retry'); member(); acknowledge();
    api.updateNativeUsageAccounts.mockRejectedValueOnce(new Error('Offline'));
    save();
    expect(await editor().findByRole('alert')).toHaveTextContent('Your draft is still here. Retry');
    expect(editor().queryByRole('link', { name: 'Open Security settings in a new tab' })).not.toBeInTheDocument();
    expect(editor().getByLabelText('Opaque account label')).toHaveValue('example-retry');
    save(); await editor().findByText(/Selections saved locally/);
    expect(api.getNativeUsageMatrix).not.toHaveBeenCalled();
  });

  it('offers operator recovery after a host-control refusal without discarding the draft', async () => {
    show('?nativeAccounts=edit&nativeAccountTab=claude');
    await editor().findByRole('button', { name: 'Add account' });
    add(); label('example-operator'); member(); acknowledge();
    api.updateNativeUsageAccounts.mockRejectedValueOnce(Object.assign(new Error('Forbidden'), { status: 403, code: 'HOST_CONTROL_FORBIDDEN' }));
    save();
    const error = await editor().findByRole('alert');
    expect(error).toHaveTextContent('requires an operator session');
    expect(error).toHaveTextContent('browser on the PortOS host');
    expect(error).toHaveTextContent('sign in with the instance password');
    expect(error).toHaveTextContent('enable it locally in Security settings');
    expect(error).not.toHaveTextContent('Retry the save or cancel');
    const setup = editor().getByRole('link', { name: 'Open Security settings in a new tab' });
    expect(setup).toHaveAttribute('href', '/settings/security');
    expect(setup).toHaveAttribute('target', '_blank');
    expect(setup).toHaveAttribute('rel', 'noopener noreferrer');
    expect(editor().getByLabelText('Opaque account label')).toHaveValue('example-operator');
    expect(editor().getByRole('checkbox', { name: /This instance/ })).toBeChecked();
    expect(editor().getByRole('checkbox', { name: /I confirm/ })).toBeChecked();
    expect(editor().getByRole('button', { name: 'Save selections' })).toBeEnabled();
    expect(api.updateNativeUsageAccounts).toHaveBeenCalledTimes(1);
    expect(api.getNativeUsageAccounts).toHaveBeenCalledTimes(1);
    expect(api.getNativeUsageMatrix).not.toHaveBeenCalled();
  });

  it('clears captured and pending matrices after a save, applies its returned state, and gates duplicate in-flight saves', async () => {
    show(); read(); await screen.findByText('123,456'); await open();
    tab('Claude Code'); add(); label('example-first'); member(); acknowledge();
    const pending = deferred();
    api.updateNativeUsageAccounts.mockReturnValueOnce(pending.promise);
    const button = editor().getByRole('button', { name: 'Save selections' });
    fireEvent.click(button); fireEvent.click(button);
    expect(api.updateNativeUsageAccounts).toHaveBeenCalledTimes(1);
    expect(editor().getByLabelText('Opaque account label')).toBeDisabled();
    expect(editor().getByRole('button', { name: 'Add account' })).toBeDisabled();
    await act(async () => pending.resolve(model([retained('claude', 'server-label')], { revision: nextRevision })));
    expect(editor().getByLabelText('Opaque account label')).toHaveValue('server-label');
    expect(screen.queryByText('123,456')).not.toBeInTheDocument();
    expect(screen.getAllByText(/Not scanned yet/)).toHaveLength(4);
    expect(api.getNativeUsageMatrix).toHaveBeenCalledTimes(1);
    fireEvent.click(editor().getByRole('button', { name: 'Cancel' }));
    const pendingRead = deferred();
    api.getNativeUsageMatrix.mockReturnValueOnce(pendingRead.promise);
    api.getNativeUsageAccounts.mockResolvedValue(model([retained('claude', 'server-label')], { revision: nextRevision }));
    read(); await open(); tab('Grok'); add(); label('next'); member(); acknowledge(); save();
    await editor().findByText(/Selections saved locally/);
    await act(async () => pendingRead.resolve({ providers: [{ family: 'codex', totals: { lifetimeTokens: 999 } }] }));
    expect(screen.queryByText('999')).not.toBeInTheDocument();
    expect(api.getNativeUsageMatrix).toHaveBeenCalledTimes(2);
  });

  it('preserves an open draft on external changes/conflicts, reloads only configuration, and invalidates reads on reconnect', async () => {
    api.getNativeUsageAccounts.mockResolvedValue(model([retained('grok')]));
    show('?nativeAccounts=edit&nativeAccountTab=grok');
    await editor().findByLabelText('Opaque account label'); label('draft'); acknowledge();
    act(() => socket.emit('usage:native-accounts-updated', { revision: nextRevision }));
    expect(editor().getByLabelText('Opaque account label')).toHaveValue('draft');
    expect(editor().getByRole('button', { name: 'Save selections' })).toBeDisabled();
    api.getNativeUsageAccounts.mockResolvedValue(model([retained('grok', 'newer')], { revision: nextRevision }));
    fireEvent.click(editor().getByRole('button', { name: 'Reload saved selections (discard draft)' }));
    await waitFor(() => expect(editor().getByLabelText('Opaque account label')).toHaveValue('newer'));
    label('second-draft'); acknowledge();
    api.updateNativeUsageAccounts.mockRejectedValueOnce(Object.assign(new Error('Conflict'), { status: 409 }));
    save();
    expect(await editor().findByText(/Selections changed since this editor loaded/)).toBeInTheDocument();
    expect(editor().getByLabelText('Opaque account label')).toHaveValue('second-draft');
    expect(editor().getByRole('button', { name: 'Save selections' })).toBeDisabled();
    expect(api.getNativeUsageMatrix).not.toHaveBeenCalled();
    fireEvent.click(editor().getByRole('button', { name: 'Cancel' }));
    api.getNativeUsageMatrix.mockResolvedValueOnce({ selectionRevision: nextRevision, providers: [{ family: 'codex', totals: { lifetimeTokens: 123456 } }], families: [] });
    read(); await screen.findByText('123,456');
    act(() => socket.emit('connect'));
    expect(screen.queryByText('123,456')).not.toBeInTheDocument();
    expect(api.getNativeUsageMatrix).toHaveBeenCalledTimes(1);
  });

  it('recovers configuration after reconnect and never lets an old save response replace a newer revision observation', async () => {
    api.getNativeUsageAccounts.mockResolvedValue(model([retained('claude')]));
    show('?nativeAccounts=edit&nativeAccountTab=claude');
    await editor().findByLabelText('Opaque account label');
    act(() => socket.emit('connect'));
    fireEvent.click(editor().getByRole('button', { name: 'Reload saved selections (discard draft)' }));
    await waitFor(() => expect(editor().queryByText(/Saved selections may have changed/)).not.toBeInTheDocument());
    label('first-save'); acknowledge();
    const saving = deferred(); api.updateNativeUsageAccounts.mockReturnValueOnce(saving.promise); save();
    const newestRevision = '3'.repeat(64);
    act(() => {
      socket.emit('usage:native-accounts-updated', { revision: nextRevision });
      socket.emit('usage:native-accounts-updated', { revision: newestRevision });
    });
    await act(async () => saving.resolve(model([retained('claude', 'first-save')], { revision: nextRevision })));
    expect(editor().getByText(/Saved selections may have changed/)).toBeInTheDocument();
    expect(editor().queryByText(/Selections saved locally/)).not.toBeInTheDocument();
    expect(editor().getByRole('button', { name: 'Save selections' })).toBeDisabled();
    fireEvent.click(editor().getByRole('button', { name: 'Cancel' }));
    api.getNativeUsageMatrix.mockResolvedValueOnce({ selectionRevision: newestRevision, providers: [{ family: 'codex', totals: { lifetimeTokens: 777 } }] });
    read();
    expect(await screen.findByText('777')).toBeInTheDocument();
    act(() => socket.emit('usage:native-accounts-updated', { revision: newestRevision }));
    expect(screen.getByText('777')).toBeInTheDocument();
    expect(api.getNativeUsageMatrix).toHaveBeenCalledTimes(1);
  });

  it('does not let a configuration load arriving behind a revision event restore stale save or snapshot authority', async () => {
    const loading = deferred(); api.getNativeUsageAccounts.mockReturnValueOnce(loading.promise);
    show('?nativeAccounts=edit&nativeAccountTab=grok');
    await act(async () => {
      socket.emit('usage:native-accounts-updated', { revision: nextRevision });
      loading.resolve(model([retained('grok', 'older-selection')]));
    });
    expect(editor().getByText(/Saved selections may have changed/)).toBeInTheDocument();
    label('draft'); acknowledge();
    expect(editor().getByRole('button', { name: 'Save selections' })).toBeDisabled();
    fireEvent.click(editor().getByRole('button', { name: 'Cancel' }));
    api.getNativeUsageMatrix.mockResolvedValueOnce({ selectionRevision: nextRevision, providers: [{ family: 'codex', totals: { lifetimeTokens: 555 } }] });
    read();
    expect(await screen.findByText('555')).toBeInTheDocument();
    expect(api.getNativeUsageMatrix).toHaveBeenCalledTimes(1);
  });

  it('supports deep links, stale tabs, Cancel and Back/Forward without restoring discarded drafts or making native reads', async () => {
    const view = show('?nativeAccounts=edit&nativeAccountTab=unknown&nativeScope=fleet');
    await editor().findByRole('button', { name: 'Add account' });
    expect(editor().getByRole('tab', { name: 'Codex' })).toHaveAttribute('aria-selected', 'true');
    tab('Antigravity'); add(); label('discard-me');
    const path = `/devtools/usage${screen.getByLabelText('Location').textContent}`;
    view.unmount();
    show(path);
    await editor().findByRole('button', { name: 'Add account' });
    expect(editor().getByRole('tab', { name: 'Antigravity' })).toHaveAttribute('aria-selected', 'true');
    expect(editor().queryByLabelText('Opaque account label')).not.toBeInTheDocument();
    fireEvent.click(editor().getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Location')).toHaveTextContent('nativeScope=fleet');
    expect(screen.getByLabelText('Location')).not.toHaveTextContent('nativeAccountTab');
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    await editor().findByRole('button', { name: 'Add account' });
    expect(editor().getByRole('tab', { name: 'Antigravity' })).toHaveAttribute('aria-selected', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Forward' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(api.getNativeUsageMatrix).not.toHaveBeenCalled();
  });

  it('drops late load/save responses after dismissal, new navigation, and unmount without reopening an editor or replacing its newer draft', async () => {
    const loading = deferred();
    api.getNativeUsageAccounts.mockReturnValueOnce(loading.promise);
    const view = show('?nativeAccounts=edit');
    fireEvent.click(editor().getByRole('button', { name: 'Close account selections' }));
    await open(); tab('Grok'); add(); label('new-draft');
    await act(async () => loading.resolve(model([retained('grok', 'old-response')])));
    expect(editor().getByLabelText('Opaque account label')).toHaveValue('new-draft');
    member(); acknowledge();
    const saving = deferred(); api.updateNativeUsageAccounts.mockReturnValueOnce(saving.promise); save();
    fireEvent.click(screen.getByRole('button', { name: 'Leave editor for fleet' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    api.getNativeUsageAccounts.mockResolvedValue(model([retained('grok', 'newer-draft')]));
    await open(); tab('Grok');
    expect(editor().getByRole('button', { name: /Saving…/ })).toBeDisabled();
    await act(async () => saving.resolve(model([retained('grok', 'old-save')], { revision: nextRevision })));
    expect(editor().getByLabelText('Opaque account label')).toHaveValue('newer-draft');
    expect(screen.getByLabelText('Native history scope')).toHaveValue('fleet');
    expect(editor().getByRole('button', { name: 'Save selections' })).toBeDisabled();
    api.getNativeUsageAccounts.mockResolvedValue(model([retained('grok', 'old-save')], { revision: nextRevision }));
    fireEvent.click(editor().getByRole('button', { name: 'Reload saved selections (discard draft)' }));
    await waitFor(() => expect(editor().getByLabelText('Opaque account label')).toHaveValue('old-save'));
    label('final-draft'); acknowledge();
    const unmountedSave = deferred(); api.updateNativeUsageAccounts.mockReturnValueOnce(unmountedSave.promise); save();
    view.unmount();
    await act(async () => unmountedSave.reject(new Error('Late failure')));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(api.getNativeUsageMatrix).not.toHaveBeenCalled();
  });

  it('gates dependent reads through a dismissed save and refuses a stale server revision without showing its totals', async () => {
    show(); await open(); tab('Claude Code'); add(); label('example-gating'); member(); acknowledge();
    expect(screen.getByRole('button', { name: 'Read native sources' })).toBeDisabled();
    const saving = deferred(); api.updateNativeUsageAccounts.mockReturnValueOnce(saving.promise); save();
    fireEvent.click(editor().getByRole('button', { name: 'Close account selections' }));
    expect(screen.getByRole('button', { name: 'Read native sources' })).toBeDisabled();
    await act(async () => saving.resolve(model([retained('claude', 'example-gating')], { revision: nextRevision })));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Read native sources' })).toBeEnabled();
    read();
    expect(await screen.findByRole('alert')).toHaveTextContent('read used different account selections');
    expect(screen.queryByText('123,456')).not.toBeInTheDocument();
    const pendingRead = deferred(); api.getNativeUsageMatrix.mockReturnValueOnce(pendingRead.promise); read();
    act(() => socket.emit('usage:native-accounts-updated', { revision: '3'.repeat(64) }));
    await act(async () => pendingRead.resolve({ selectionRevision: nextRevision, providers: [{ family: 'codex', totals: { lifetimeTokens: 888 } }] }));
    expect(screen.queryByText('888')).not.toBeInTheDocument();
    expect(screen.getAllByText(/Not scanned yet/)).toHaveLength(4);
    expect(api.getNativeUsageMatrix).toHaveBeenCalledTimes(2);
  });

  it('saves existing four-provider selections through the HTTP wrappers after visiting every tab', async () => {
    const accountLabel = 'example-subscription-with-long-unbroken-label-for-geometry-check';
    const savedModel = model(['codex', 'claude', 'grok', 'agy'].map(family => ({
      family, accountLabel, members: [local, peer, missing],
      ...(family === 'codex' ? { authoritativeParticipant: local } : { historyScope: 'operator-confirmed-retained-history' }),
    })), { participants: [...model().participants, { participantKey: missing, kind: 'unavailable', status: 'not-configured' }], inventory: { status: 'truncated', maxPeers: 64 } });
    const fetchRequest = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, options) => ({
      ok: true, json: async () => options.method === 'PUT'
        ? { ...savedModel, selections: JSON.parse(options.body).selections, revision: nextRevision }
        : savedModel,
    }));
    api.getNativeUsageAccounts.mockImplementationOnce(getNativeUsageAccounts);
    api.updateNativeUsageAccounts.mockImplementationOnce(updateNativeUsageAccounts);
    show(); read(); await screen.findByText('123,456'); await open();
    for (const provider of ['Codex', 'Claude Code', 'Grok', 'Antigravity']) {
      tab(provider);
      expect(editor().getByRole('checkbox', { name: /Missing saved member/ })).toBeChecked();
    }
    tab('Codex');
    const codexPanel = within(editor().getByRole('tabpanel', { name: 'Codex', exact: true }));
    fireEvent.change(codexPanel.getByLabelText('Opaque account label'), { target: { value: 'example-updated-subscription' } });
    fireEvent.click(codexPanel.getByRole('button', { name: 'Save selections' }));
    expect(await codexPanel.findByText(/Selections saved locally/)).toBeInTheDocument();
    expect(fetchRequest).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchRequest.mock.calls[1][1].body)).toEqual({ expectedRevision: revision, selections: savedModel.selections.map(selection => selection.family === 'codex'
      ? { ...selection, accountLabel: 'example-updated-subscription' } : selection) });
    expect(editor().queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByText('123,456')).not.toBeInTheDocument();
  });

  it('keeps options out of GET/PUT payloads and renders wrapper errors in one owned boundary', async () => {
    const fetchRequest = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({ ok: true, json: async () => model([retained('claude')]) })
      .mockResolvedValueOnce({ ok: false, status: 409, json: async () => ({ error: 'Revision conflict' }) });
    api.getNativeUsageAccounts.mockImplementationOnce(getNativeUsageAccounts);
    api.updateNativeUsageAccounts.mockImplementationOnce(updateNativeUsageAccounts);
    show('?nativeAccounts=edit&nativeAccountTab=claude');
    await editor().findByLabelText('Opaque account label');
    label('changed'); acknowledge(); save();
    await editor().findByText(/Selections changed since this editor loaded/);
    expect(fetchRequest).toHaveBeenNthCalledWith(1, '/api/usage/native-accounts', { headers: { 'Content-Type': 'application/json' } });
    expect(fetchRequest).toHaveBeenNthCalledWith(2, '/api/usage/native-accounts', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedRevision: revision, selections: [retained('claude', 'changed')] }) });
  });
});
