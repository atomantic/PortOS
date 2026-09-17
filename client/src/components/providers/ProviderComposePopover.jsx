/**
 * The "Custom combination…" compose flow (#7566): harness → method → service
 * → model → effort, narrowing at each step, plus an optional credential
 * bootstrap select and "Save as preset" — everything `ProviderModelSelector`'s
 * preset-first list defers to once the user asks for something not already a
 * preset.
 *
 * Renders NOTHING (returns `null`) while closed, and requests
 * `useProviderCatalog` only while open — a picker that never opens compose
 * pays for no catalog fetch. Every field is a native, keyboard-operable,
 * `FormField`-labelled `<select>`; the panel is `Modal`'s standard chrome, so
 * focus is trapped while open and returned to the trigger on close (WCAG
 * 2.4.3 / 2.1.2) for free.
 *
 * @param {object} props
 * @param {boolean} props.open
 * @param {function} props.onClose
 * @param {function} props.onCompose - `(compositeId, { model, effort }) => void`.
 *   Called for "Use once" — the caller stores the composite id in its existing
 *   `{ providerId, model, effort }` field; nothing is persisted server-side.
 * @param {function} [props.onPresetSaved] - `(presetRecord) => void`. Called
 *   after "Save as preset" succeeds, so the caller can select the new preset
 *   id in place of the composite.
 * @param {string[]} [props.allowedMethods] - Restrict the method (and so the
 *   harnesses offered) to this caller's mode policy, e.g. `['tui']` for
 *   `ShellProviderLauncher`. Omit for no restriction.
 * @param {string} [props.title] - Panel heading (default: "Compose a custom combination").
 * @param {{harnessId?: string, method?: string, serviceSlug?: string}} [props.initial] -
 *   Pre-select these steps on open — the compatibility matrix on the AI
 *   Providers page (#7567) opens the flow on the pair the user clicked. Each
 *   later step stays open for the user to narrow.
 * @param {boolean} [props.useOnce] - Offer the "Use once" button (default
 *   true). The AI Providers page has no selection to hand a composite to, so
 *   it offers only "Save as preset".
 */
import { useEffect, useId, useMemo, useState } from 'react';
import Modal from '../ui/Modal.jsx';
import { FormField } from '../ui/FormField.jsx';
import EffortSelect from '../cos/EffortSelect.jsx';
import useProviderCatalog from '../../hooks/useProviderCatalog.js';
import { useAsyncAction } from '../../hooks/useAsyncAction.js';

const SELECT_CLASS = 'w-full px-3 py-1.5 min-h-[36px] bg-port-bg border border-port-border rounded-lg text-white text-sm';

/** The readiness line under the service select: harness detection + service credential/daemon state. */
const READINESS_LABEL = {
  ready: 'ready to run',
  'needs-credential': 'needs a credential',
  'needs-endpoint': 'needs an endpoint',
  disabled: 'switched off',
  'unknown-definition': 'unknown service definition',
};

export default function ProviderComposePopover({
  open,
  onClose,
  onCompose,
  onPresetSaved,
  allowedMethods,
  title = 'Compose a custom combination',
  initial = null,
  useOnce = true,
}) {
  const catalog = useProviderCatalog(open);
  const [harnessId, setHarnessId] = useState('');
  const [method, setMethod] = useState('');
  const [serviceSlug, setServiceSlug] = useState('');
  const [model, setModel] = useState('');
  const [effort, setEffort] = useState('');
  const [bootstrapSlug, setBootstrapSlug] = useState('');
  const [presetName, setPresetName] = useState('');
  const [showPresetField, setShowPresetField] = useState(false);

  // Reset to a blank compose every time the popover is (re)opened, so a
  // previous "Use once" choice never lingers into the next open.
  useEffect(() => {
    if (!open) return;
    setHarnessId(initial?.harnessId || '');
    setMethod(initial?.method || '');
    setServiceSlug(initial?.serviceSlug || '');
    setModel('');
    setEffort('');
    setBootstrapSlug('');
    setPresetName('');
    setShowPresetField(false);
  }, [open, initial]);

  const harnesses = useMemo(
    () => (catalog.harnesses || []).filter((harness) => harness.enabled
      && (!allowedMethods || harness.modes.some((mode) => allowedMethods.includes(mode)))),
    [catalog.harnesses, allowedMethods],
  );
  const methods = useMemo(() => {
    const all = catalog.methodsFor(harnessId);
    return allowedMethods ? all.filter((mode) => allowedMethods.includes(mode)) : all;
  }, [catalog, harnessId, allowedMethods]);
  const services = useMemo(() => catalog.compatiblePairs(harnessId), [catalog, harnessId]);
  const selectedService = services.find((service) => service.slug === serviceSlug) || null;
  const models = catalog.modelsFor(serviceSlug);
  const effortLevels = catalog.effortLevelsFor(harnessId, model || null);
  const bootstraps = catalog.bootstraps || [];
  const bootstrapEligible = (method === 'cli' || method === 'tui') && bootstraps.length > 0;
  const bootstrapRequired = selectedService?.credentialVia === 'bootstrap';
  const selectedHarness = harnesses.find((harness) => harness.id === harnessId) || null;

  const compositeId = harnessId && method && serviceSlug
    ? `${harnessId}.${method}@${serviceSlug}${bootstrapSlug ? `+${bootstrapSlug}` : ''}`
    : null;
  const canCompose = Boolean(compositeId) && (!bootstrapRequired || bootstrapSlug);

  const [saveAsPreset, saving] = useAsyncAction(async () => {
    const created = await catalog.savePreset({
      compositeId,
      name: presetName.trim() || undefined,
      model: model || null,
      effort: effort || null,
    });
    onPresetSaved?.(created);
    onClose();
    return created;
  }, { errorMessage: 'Could not save this combination as a preset' });

  const handleHarnessChange = (value) => {
    setHarnessId(value);
    setMethod('');
    setServiceSlug('');
    setModel('');
    setEffort('');
    setBootstrapSlug('');
  };
  // Clearing/changing the method hides the Service select (gated on
  // `harnessId && method`), so every field downstream of it must be reset
  // too — model/effort are gated on `serviceSlug` alone, not on `method`,
  // and would otherwise stay rendered with a now-orphaned selection.
  const handleMethodChange = (value) => {
    setMethod(value);
    setServiceSlug('');
    setModel('');
    setEffort('');
    setBootstrapSlug('');
  };
  const handleServiceChange = (value) => {
    setServiceSlug(value);
    setModel('');
    setEffort('');
    setBootstrapSlug('');
  };
  // A model's effort ladder narrows (or disappears) per model — clear a stale
  // effort that the newly-picked model's ladder no longer offers, or a value
  // the UI no longer shows a control for would still ride into onCompose /
  // savePreset.
  const handleModelChange = (value) => {
    setModel(value);
    const nextLevels = catalog.effortLevelsFor(harnessId, value || null);
    if (effort && !nextLevels.includes(effort)) setEffort('');
  };

  const harnessSelectId = useId();
  const methodSelectId = useId();
  const serviceSelectId = useId();
  const modelSelectId = useId();
  const bootstrapSelectId = useId();
  const presetNameId = useId();

  return (
    <Modal open={open} onClose={onClose} size="sm" usePortal ariaLabel={title}>
      <div className="p-4 flex flex-col gap-3">
        <h2 className="text-base font-semibold text-white">{title}</h2>

        <FormField label="Harness" className="mb-0">
          <select
            id={harnessSelectId}
            className={SELECT_CLASS}
            value={harnessId}
            disabled={catalog.loading}
            onChange={(e) => handleHarnessChange(e.target.value)}
          >
            <option value="">{catalog.loading ? 'Loading harnesses…' : 'Choose a harness…'}</option>
            {harnesses.map((harness) => (
              <option key={harness.id} value={harness.id}>{harness.label}</option>
            ))}
          </select>
        </FormField>

        {harnessId && (
          <FormField label="Method" className="mb-0">
            <select
              id={methodSelectId}
              className={SELECT_CLASS}
              value={method}
              onChange={(e) => handleMethodChange(e.target.value)}
            >
              <option value="">Choose a method…</option>
              {methods.map((mode) => (
                <option key={mode} value={mode}>{mode.toUpperCase()}</option>
              ))}
            </select>
          </FormField>
        )}

        {harnessId && method && (
          <FormField label="Service" className="mb-0">
            <select
              id={serviceSelectId}
              className={SELECT_CLASS}
              value={serviceSlug}
              onChange={(e) => handleServiceChange(e.target.value)}
            >
              <option value="">Choose a service…</option>
              {services.map((service) => (
                <option key={service.slug} value={service.slug}>{service.label}</option>
              ))}
            </select>
            {selectedService && (
              <p className="text-xs text-gray-500 mt-1">
                {selectedHarness?.detected === false ? `${selectedHarness.label} not detected on this machine — ` : ''}
                {READINESS_LABEL[selectedService.readiness] || selectedService.readiness}
              </p>
            )}
          </FormField>
        )}

        {serviceSlug && models.length > 0 && (
          <FormField label="Model" className="mb-0">
            <select id={modelSelectId} className={SELECT_CLASS} value={model} onChange={(e) => handleModelChange(e.target.value)}>
              <option value="">Default model</option>
              {models.map((m) => {
                const value = typeof m === 'string' ? m : m.id;
                const label = typeof m === 'string' ? m : (m.name || m.id);
                return <option key={value} value={value}>{label}</option>;
              })}
            </select>
          </FormField>
        )}

        {serviceSlug && effortLevels.length > 0 && (
          <FormField label="Thinking effort" className="mb-0">
            <EffortSelect
              provider={{ harnessId, effort: '', type: method }}
              model={model || null}
              value={effort}
              onChange={setEffort}
              className={SELECT_CLASS}
            />
          </FormField>
        )}

        {bootstrapEligible && (
          <FormField label={`Credential bootstrap${bootstrapRequired ? ' (required)' : ''}`} className="mb-0">
            <select
              id={bootstrapSelectId}
              className={SELECT_CLASS}
              value={bootstrapSlug}
              onChange={(e) => setBootstrapSlug(e.target.value)}
            >
              <option value="">{bootstrapRequired ? 'Choose a bootstrap app…' : 'None'}</option>
              {bootstraps.map((app) => (
                <option key={app.slug} value={app.slug}>{app.label}</option>
              ))}
            </select>
            {bootstrapRequired && (
              <p className="text-xs text-gray-500 mt-1">
                This service authenticates through a wrapper app — pick which one supplies the credential.
              </p>
            )}
          </FormField>
        )}

        {showPresetField && (
          <FormField label="Preset name" className="mb-0">
            <input
              id={presetNameId}
              type="text"
              className={SELECT_CLASS}
              value={presetName}
              onChange={(e) => setPresetName(e.target.value)}
              placeholder={selectedHarness && selectedService ? `${selectedHarness.label} · ${selectedService.label}` : 'Preset name'}
            />
          </FormField>
        )}

        <div className="flex flex-col sm:flex-row gap-2 mt-1">
          {useOnce && (
            <button
              type="button"
              className="flex-1 px-3 py-1.5 rounded-lg bg-port-bg border border-port-border text-white text-sm hover:bg-port-border disabled:opacity-50"
              disabled={!canCompose}
              onClick={() => { onCompose(compositeId, { model, effort }); onClose(); }}
            >
              Use once
            </button>
          )}
          {!showPresetField ? (
            <button
              type="button"
              className="flex-1 px-3 py-1.5 rounded-lg bg-port-bg border border-port-border text-white text-sm hover:bg-port-border disabled:opacity-50"
              disabled={!canCompose}
              onClick={() => setShowPresetField(true)}
            >
              Save as preset…
            </button>
          ) : (
            <button
              type="button"
              className="flex-1 px-3 py-1.5 rounded-lg bg-port-accent text-white text-sm hover:opacity-90 disabled:opacity-50"
              disabled={!canCompose || saving}
              onClick={saveAsPreset}
            >
              {saving ? 'Saving…' : 'Confirm save'}
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}
