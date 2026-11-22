import { useState, useEffect } from 'react';
import Drawer from '../Drawer';
import FormField from '../ui/FormField';
import { useAsyncAction } from '../../hooks/useAsyncAction';
import { createWebsiteLogin, updateWebsiteLogin } from '../../services/apiPrivacy.js';
import toast from '../ui/Toast';
import { INPUT_CLS } from './constants';

// Create/edit one origin-bound website login (#17397). Secrets are write-only:
// the server never returns the username, password or TOTP setup key, so edit
// mode starts those fields blank and a blank field means "keep the stored
// value". Only the label, origins and notes are prefilled.
const EMPTY = { label: '', origins: '', username: '', password: '', totpSecret: '', removeTotp: false, notes: '' };

// One origin per line (commas also split). The server reduces each to its exact
// scheme://host[:port] origin and rejects anything that isn't http(s).
const parseOrigins = (text) => text.split(/[\n,]/).map((line) => line.trim()).filter(Boolean);

export default function WebsiteLoginDrawer({ open, login, subjectId, onClose, onSaved }) {
  const editing = !!login;
  const [form, setForm] = useState(EMPTY);

  useEffect(() => {
    if (!open) return;
    setForm(login
      ? { ...EMPTY, label: login.label ?? '', origins: (login.origins ?? []).join('\n'), notes: login.notes ?? '' }
      : { ...EMPTY });
  }, [open, login]);

  const set = (key, value) => setForm((prev) => ({ ...prev, [key]: value }));

  const [save, saving] = useAsyncAction(async () => {
    const origins = parseOrigins(form.origins);
    if (!form.label.trim()) { toast.error('Label is required'); return null; }
    if (origins.length === 0) { toast.error('Add at least one origin, such as https://example.com'); return null; }
    if (!editing && (!form.username || !form.password)) { toast.error('Username and password are required'); return null; }

    const payload = { label: form.label.trim(), origins };
    // Notes go out on create, and on edit only when changed from the loaded value.
    if (!editing || form.notes !== (login.notes ?? '')) payload.notes = form.notes;
    // Send a secret only when the user typed one; absent keeps the stored value.
    if (form.username) payload.username = form.username;
    if (form.password) payload.password = form.password;
    if (form.totpSecret.trim()) payload.totpSecret = form.totpSecret.trim();
    else if (editing && form.removeTotp) payload.totpSecret = null;

    const result = editing
      ? await updateWebsiteLogin(login.id, payload, { silent: true })
      : await createWebsiteLogin({ ...payload, subjectId }, { silent: true });
    if (result) {
      toast.success(editing ? 'Website login updated' : 'Website login saved');
      onSaved(result, editing);
    }
    return result;
  }, { errorMessage: editing ? 'Failed to update website login' : 'Failed to save website login' });

  const keepHint = editing ? 'Leave blank to keep the stored value.' : null;

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={editing ? 'Edit website login' : 'New website login'}
      subtitle={editing ? login?.label : undefined}
      size="md"
      closeOnEsc={false}
      closeOnBackdrop={false}
    >
      <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); save(); }}>
        <FormField label="Label">
          <input
            type="text"
            value={form.label}
            onChange={(event) => set('label', event.target.value)}
            placeholder="e.g. Distributor portal"
            className={INPUT_CLS}
            maxLength={200}
          />
        </FormField>

        <FormField
          label="Allowed origins"
          hint="One per line. Fill runs only when the tab's origin matches one exactly: https://example.com does not match https://www.example.com or http://example.com."
        >
          <textarea
            value={form.origins}
            onChange={(event) => set('origins', event.target.value)}
            rows={3}
            placeholder="https://example.com"
            className={`${INPUT_CLS} font-mono`}
            spellCheck={false}
          />
        </FormField>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <FormField label="Username or email" hint={keepHint}>
            <input
              type="text"
              value={form.username}
              onChange={(event) => set('username', event.target.value)}
              placeholder={editing ? login?.maskedUsername : ''}
              autoComplete="off"
              className={INPUT_CLS}
              maxLength={512}
            />
          </FormField>
          <FormField label="Password" hint={keepHint}>
            <input
              type="password"
              value={form.password}
              onChange={(event) => set('password', event.target.value)}
              placeholder={editing ? '••••••••' : ''}
              autoComplete="new-password"
              className={INPUT_CLS}
              maxLength={4096}
            />
          </FormField>
        </div>

        <FormField
          label="2FA setup key (optional)"
          hint={editing && login?.hasTotp
            ? 'A setup key is saved. Paste a new one to replace it.'
            : 'The Base32 key or otpauth://totp/... link shown when you set up an authenticator app. PortOS generates the codes; nobody sees the key again.'}
        >
          <input
            type="password"
            value={form.totpSecret}
            onChange={(event) => set('totpSecret', event.target.value)}
            autoComplete="off"
            className={`${INPUT_CLS} font-mono`}
            maxLength={2048}
          />
        </FormField>

        {editing && login?.hasTotp && (
          <label className="flex items-center gap-2 text-sm text-gray-300 cursor-pointer">
            <input
              type="checkbox"
              checked={form.removeTotp}
              disabled={!!form.totpSecret.trim()}
              onChange={(event) => set('removeTotp', event.target.checked)}
            />
            Remove the saved 2FA setup key
          </label>
        )}

        <FormField label="Notes">
          <textarea
            value={form.notes}
            onChange={(event) => set('notes', event.target.value)}
            rows={2}
            className={INPUT_CLS}
            maxLength={5000}
          />
        </FormField>

        <p className="text-xs text-gray-500">
          Encrypted at rest and write-only: PortOS never shows the password or setup key again. Agents with the
          website login fill grant can have PortOS type it into a matching browser tab without seeing it.
        </p>

        <div className="flex items-center justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} className="px-3 py-2 text-sm rounded border border-port-border text-gray-300 hover:text-white">Cancel</button>
          <button
            type="submit"
            disabled={saving}
            className="px-4 py-2 text-sm rounded bg-port-accent text-white hover:bg-port-accent/80 disabled:opacity-50"
          >
            {saving ? 'Saving…' : (editing ? 'Save changes' : 'Save login')}
          </button>
        </div>
      </form>
    </Drawer>
  );
}
