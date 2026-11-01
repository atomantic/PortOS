/**
 * Image Gen Settings — backend picker (External SD API / local mflux / Codex
 * CLI), per-mode configuration, and the "expose A1111 API on the tailnet"
 * toggle so other machines can use this PortOS as their image/video backend.
 * Codex appears as a backend tile only after the user enables it; the toggle
 * lives in the always-visible Codex CLI Imagegen section.
 *
 * This component owns the one `useSettingsForm` every field lives in, the
 * load and the field-by-field save; the sections are three sibling
 * components reading the same form: ImageGenBackendSections (Backend,
 * Defaults), ImageGenProviderSections (External, Local, Codex, Grok, Agy,
 * fal.ai) and ImageGenServiceSections (Tokens, Expose, Test).
 */

import { useState, useEffect, useCallback } from 'react';
import {
  Save, Image as ImageIcon, Zap, Wrench, Cloud, Cpu, Globe,
  Sparkles, Terminal, Key, SlidersHorizontal, Bot, FlaskConical,
} from 'lucide-react';
import toast from '../ui/Toast';
import TabPills from '../ui/TabPills';
import BrailleSpinner from '../BrailleSpinner';
import LoadFailedState from '../ui/LoadFailedState';
import useDrawerTab from '../../hooks/useDrawerTab';
import useSettingsForm from '../../hooks/useSettingsForm';
import {
  getSettings, patchSettingsSlice, getImageGenStatus,
  registerTool, updateTool, getToolsList,
  getCredentialInventory, saveCredential,
} from '../../services/api';
import {
  isLocalImageConfigured, imageGenReadiness, IMAGE_GEN_MODE, falImageFamily, LOCAL_IMAGEGEN_DEFAULT_MODEL,
  RENDER_TARGET_BACKEND_AUTO, RENDER_TARGET_OPTIONS, normalizeRenderPinValue,
} from '../../lib/imageGenBackends';
import useLocalImageRuntime from '../../hooks/useLocalImageRuntime';
import { resolveCleanersFromConfig } from '../../lib/imageCleaners';
import ImageGenBackendSections from './ImageGenBackendSections';
import ImageGenProviderSections, { PARALLEL_FALLBACK, clampParallel } from './ImageGenProviderSections';
import ImageGenServiceSections from './ImageGenServiceSections';

const SDAPI_TOOL_ID = 'sdapi';
const CODEX_TOOL_ID = 'codex-imagegen';
const GROK_TOOL_ID = 'grok-imagegen';
const AGY_TOOL_ID = 'agy-imagegen';
const normalizeUrl = (url) => (url || '').trim().replace(/\/+$/, '');

// Sub-navigation for this settings surface. Rendered as internal TabPills
// (pills variant + mobile <select>) rather than a tabbed <Drawer>, so the same
// grouping works whether ImageGenTab is hosted in a plain Drawer (ImageGen /
// VideoGen / StoryboardPanel) or elsewhere — no tabs-within-tabs. The active
// tab deep-links via the `mediaTab` search param (useDrawerTab).
// `probeMode` binds a provider tab to the backend the shared Test Connection
// button should probe. Without it the button always probed the *saved default*
// mode, so testing from the Grok or Agy tab reported the Codex CLI's version
// ("codex — codex-cli 0.145.0") — the answer to a question nobody asked.
// Tabs with no provider of their own (Backend / Tokens / Expose / Test) leave
// it undefined and fall back to the saved default backend.
// Exported so a test can assert every IMAGE_GEN_MODE is tagged onto some tab —
// a new backend that forgets its `probeMode` would otherwise silently regress
// to probing the saved default again.
export const MEDIA_TABS = [
  { id: 'backend', label: 'Backend', icon: ImageIcon },
  { id: 'defaults', label: 'Defaults', icon: SlidersHorizontal },
  { id: 'external', label: 'External', icon: Cloud, probeMode: IMAGE_GEN_MODE.EXTERNAL },
  { id: 'local', label: 'Local', icon: Cpu, probeMode: IMAGE_GEN_MODE.LOCAL },
  { id: 'codex', label: 'Codex CLI', icon: Terminal, probeMode: IMAGE_GEN_MODE.CODEX },
  { id: 'grok', label: 'Grok CLI', icon: Zap, probeMode: IMAGE_GEN_MODE.GROK },
  { id: 'agy', label: 'Agy CLI', icon: Bot, probeMode: IMAGE_GEN_MODE.AGY },
  { id: 'runway', label: 'Runway', icon: Sparkles, probeMode: IMAGE_GEN_MODE.RUNWAY },
  { id: 'fal', label: 'fal.ai', icon: Sparkles, probeMode: IMAGE_GEN_MODE.FAL },
  { id: 'tokens', label: 'Tokens', icon: Key },
  { id: 'expose', label: 'Expose', icon: Globe },
  { id: 'test', label: 'Test', icon: FlaskConical },
];
const MEDIA_TAB_IDS = MEDIA_TABS.map((t) => t.id);

// Every settings field the drawer edits, in the shape the form holds. Adding a
// field is one entry here plus its load line in `mediaFormFromSettings` and
// its slice in `sliceFieldsOf` — the dirty check and payload are generic.
const EMPTY_MEDIA_FORM = Object.freeze({
  mode: IMAGE_GEN_MODE.EXTERNAL,
  sdapiUrl: '',
  pythonPath: '',
  // Install-wide default local image model (`settings.imageGen.local.modelId`).
  // '' = no pin, which the server resolves to LOCAL_IMAGEGEN_DEFAULT_MODEL.
  localModelId: '',
  exposeA1111: false,
  // Codex CLI provider config — gated by `codexEnabled` so users without a
  // paid Codex plan that includes image_gen can hide the option entirely.
  // Empty model/effort = the shipped defaults.
  codexEnabled: false,
  codexPath: '',
  codexModel: '',
  codexEffort: '',
  codexParallelLimit: 1,
  // Grok Build CLI provider config — gated like Codex (renders spend the
  // user's Grok quota). Empty aspect ratio = let the caller's size decide.
  grokEnabled: false,
  grokPath: '',
  grokAspectRatio: '',
  agyEnabled: false,
  agyPath: '',
  agyModel: '',
  runwayEnabled: false,
  runwayModel: 'gen4_image',
  runwayResolution: '720p',
  // fal.ai image backend — a metered API, gated by its own toggle like the
  // CLIs. The API key is NOT part of this slice: it is the fal.ai credential
  // the video backend already owns (the Defaults tab's key row).
  falEnabled: false,
  // '' = no pin → FAL_IMAGE_DEFAULT_MODEL server-side.
  falModel: '',
  // Per-provider cleaner toggles (see CleanersToggles in the provider sections).
  cleanC2PAByMode: { external: true, local: true, codex: true, grok: false, agy: false, fal: false, runway: false },
  denoiseByMode: { external: false, local: false, codex: false, grok: false, agy: false, fal: false, runway: false },
  // Per-surface render defaults (#3231) — `{ [target]: { imageMode, imageModel, videoMode } }`.
  renderDefaults: {},
  // Install-wide video backend pin (`settings.videoGen.mode`, #3231 Phase 4). '' = no pin (local).
  videoGenMode: '',
  localVideoModelId: '',
  videoGenDisplaySleep: false,
});

// The form values a settings GET loads into, plus the server-authoritative
// bounds for the parallel-limit input.
const mediaFormFromSettings = (s) => {
  const ig = s?.imageGen || {};
  const cx = ig.codex || {};
  const gk = ig.grok || {};
  const ay = ig.agy || {};
  const fl = ig.fal || {};
  const vg = (s?.videoGen && typeof s.videoGen === 'object') ? s.videoGen : {};
  const bounds = cx.parallelLimitBounds && Number.isFinite(cx.parallelLimitBounds.max)
    ? cx.parallelLimitBounds
    : PARALLEL_FALLBACK;
  // Per-mode cleaner reads via the shared helper (mirrored from server/lib/imageClean.js).
  const cleaners = Object.fromEntries([
    [IMAGE_GEN_MODE.EXTERNAL, ig.external], [IMAGE_GEN_MODE.LOCAL, ig.local], [IMAGE_GEN_MODE.CODEX, cx],
    [IMAGE_GEN_MODE.GROK, gk], [IMAGE_GEN_MODE.AGY, ay], [IMAGE_GEN_MODE.FAL, fl], [IMAGE_GEN_MODE.RUNWAY, ig.runway],
  ].map(([m, config]) => [m, resolveCleanersFromConfig(config, m)]));
  const values = {
    mode: ig.mode || IMAGE_GEN_MODE.EXTERNAL,
    sdapiUrl: normalizeUrl(ig.external?.sdapiUrl || ig.sdapiUrl),
    pythonPath: ig.local?.pythonPath || '',
    localModelId: ig.local?.modelId || '',
    exposeA1111: ig.expose?.a1111 === true,
    codexEnabled: cx.enabled === true,
    codexPath: cx.codexPath || '',
    codexModel: cx.model || '',
    codexEffort: cx.effort || '',
    codexParallelLimit: clampParallel(cx.parallelLimit, bounds),
    grokEnabled: gk.enabled === true,
    grokPath: gk.grokPath || '',
    grokAspectRatio: gk.aspectRatio || '',
    agyEnabled: ay.enabled === true,
    agyPath: ay.agyPath || '',
    agyModel: ay.model || '',
    runwayEnabled: ig.runway?.enabled === true,
    runwayModel: ig.runway?.model || 'gen4_image',
    runwayResolution: ig.runway?.resolution || '720p',
    falEnabled: fl.enabled === true,
    falModel: fl.model || '',
    cleanC2PAByMode: Object.fromEntries(Object.entries(cleaners).map(([m, c]) => [m, c.cleanC2PA])),
    denoiseByMode: Object.fromEntries(Object.entries(cleaners).map(([m, c]) => [m, c.denoise])),
    // Load every target entry whole (including videoModel keys this tab
    // doesn't edit) — an entry is saved as one unit when it changes.
    renderDefaults: (s?.renderDefaults && typeof s.renderDefaults === 'object') ? s.renderDefaults : {},
    // Video pin: normalize the mode ('auto'/blank → '', i.e. no pin) for the select.
    videoGenMode: normalizeRenderPinValue(vg.mode) || '',
    localVideoModelId: vg.defaultModelId || '',
    videoGenDisplaySleep: vg.displaySleep === true,
  };
  return { values, bounds };
};

// Per-surface render defaults (#3231). Entries with no effective pin are
// dropped so settings.json doesn't accumulate `{ imageMode: 'auto' }` no-ops
// for every surface the user merely glanced at.
const pruneRenderDefaults = (rd) => Object.fromEntries(
  Object.entries(rd).filter(([, entry]) => entry && Object.values(entry).some(
    (v) => typeof v === 'string' && v.trim() && v !== RENDER_TARGET_BACKEND_AUTO,
  )),
);

// What the server will hold after a save: the form, normalized the way the
// inputs are reflected back afterwards (trimmed paths/models, clamped
// parallel limit, pruned render defaults).
const normalizeMediaForm = (f, parallelBounds) => ({
  ...f,
  sdapiUrl: normalizeUrl(f.sdapiUrl),
  codexPath: f.codexPath.trim(),
  codexModel: f.codexModel.trim(),
  codexEffort: f.codexEffort.trim(),
  codexParallelLimit: clampParallel(f.codexParallelLimit, parallelBounds),
  grokPath: f.grokPath.trim(),
  grokAspectRatio: f.grokAspectRatio.trim(),
  agyPath: f.agyPath.trim(),
  agyModel: f.agyModel.trim(),
  renderDefaults: pruneRenderDefaults(f.renderDefaults),
});

// Every settings field this drawer owns, grouped by the slice PATCH that
// persists it (server: settingsSlicePartialSchemas). The server merges per
// field inside the selected slice, so a save sends only the fields that
// changed since load and never a snapshot of a sibling — a value VideoGen's
// LocalSetupPanel patched after the drawer opened (`imageGen.local.pythonPath`)
// or a hand-edited key the drawer never renders (`imageGen.local.steps`)
// survives. Cleared strings travel as '' (every reader falls back on a blank);
// the two pins readers coerce with `||` go as null so an un-pin needs no
// sentinel string. `renderDefaults` merges per target, so a cleared surface
// is an explicit null.
const sliceFieldsOf = (f) => ({
  imageGen: { mode: f.mode, sdapiUrl: f.sdapiUrl },
  'imageGen.external': { sdapiUrl: f.sdapiUrl, cleanC2PA: f.cleanC2PAByMode.external, denoise: f.denoiseByMode.external },
  'imageGen.local': {
    pythonPath: f.pythonPath || null,
    modelId: f.localModelId || null,
    cleanC2PA: f.cleanC2PAByMode.local,
    denoise: f.denoiseByMode.local,
  },
  'imageGen.codex': {
    enabled: f.codexEnabled, codexPath: f.codexPath, model: f.codexModel, effort: f.codexEffort,
    parallelLimit: f.codexParallelLimit, cleanC2PA: f.cleanC2PAByMode.codex, denoise: f.denoiseByMode.codex,
  },
  'imageGen.grok': {
    enabled: f.grokEnabled, grokPath: f.grokPath, aspectRatio: f.grokAspectRatio,
    cleanC2PA: f.cleanC2PAByMode.grok, denoise: f.denoiseByMode.grok,
  },
  'imageGen.agy': {
    enabled: f.agyEnabled, agyPath: f.agyPath, model: f.agyModel,
    cleanC2PA: f.cleanC2PAByMode.agy, denoise: f.denoiseByMode.agy,
  },
  'imageGen.runway': {
    enabled: f.runwayEnabled, model: f.runwayModel, resolution: f.runwayResolution,
    cleanC2PA: f.cleanC2PAByMode.runway, denoise: f.denoiseByMode.runway,
  },
  'imageGen.fal': {
    enabled: f.falEnabled, model: falImageFamily(f.falModel) ? f.falModel : '',
    cleanC2PA: f.cleanC2PAByMode.fal, denoise: f.denoiseByMode.fal,
  },
  'imageGen.expose': { a1111: f.exposeA1111 },
  renderDefaults: Object.fromEntries(RENDER_TARGET_OPTIONS.map(({ id }) => [id, f.renderDefaults[id] ?? null])),
  videoGen: { mode: f.videoGenMode || null, defaultModelId: f.localVideoModelId || null, displaySleep: f.videoGenDisplaySleep },
});

// `[slicePath, partial]` pairs that move the persisted fields from `previous`
// to `next`; a slice with no changed field is not sent at all.
const diffSlicePatches = (next, previous) => {
  const before = sliceFieldsOf(previous);
  return Object.entries(sliceFieldsOf(next)).flatMap(([slicePath, fields]) => {
    const changed = Object.entries(fields)
      .filter(([key, value]) => JSON.stringify(value) !== JSON.stringify(before[slicePath][key]));
    return changed.length ? [[slicePath, Object.fromEntries(changed)]] : [];
  });
};

export function ImageGenTab() {
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [saving, setSaving] = useState(false);

  // Deep-linkable active sub-tab, backed by the `mediaTab` search param so the
  // open section survives reload/share and is reachable from a bookmark. A
  // stale/hand-edited value degrades to 'backend'.
  const [mediaTab, setMediaTab] = useDrawerTab('mediaTab', 'backend', MEDIA_TAB_IDS);

  const form = useSettingsForm(EMPTY_MEDIA_FORM);
  const { values, saved, isDirty } = form;
  // Server-authoritative bounds for the parallel-limit input. Populated from
  // /api/settings's `imageGen.codex.parallelLimitBounds`; falls back to local
  // constants until the first fetch resolves.
  const [parallelBounds, setParallelBounds] = useState(PARALLEL_FALLBACK);

  const [status, setStatus] = useState(null);
  const [checking, setChecking] = useState(false);
  const [toolRegistered, setToolRegistered] = useState(false);
  const [codexToolRegistered, setCodexToolRegistered] = useState(false);
  const [grokToolRegistered, setGrokToolRegistered] = useState(false);
  const [agyToolRegistered, setAgyToolRegistered] = useState(false);

  // fal.ai / reactor.inc video keys (#6213/#6214) — write-only since #8997:
  // the raw key never appears in a settings GET (privateKeyStore.js hydrates
  // it server-side, but redactExternalTokens strips it back out). The client
  // reads only presence + source from the shared credential inventory
  // (GET /api/settings/credentials, same one CredentialsTab renders) and
  // saves/clears through the write-only PUT /api/settings/credentials/:id
  // setter — never through the slice PATCHes this tab otherwise uses.
  const [credentialRows, setCredentialRows] = useState({ fal: null, reactor: null, runway: null });
  // One busy flag for both keys since only one save/clear can be in flight
  // from this panel at a time; the value names which button is spinning.
  const [videoCredentialBusy, setVideoCredentialBusy] = useState(null);

  const refreshCredentialRows = useCallback(() => {
    getCredentialInventory({ silent: true })
      .then((data) => {
        const rows = data?.credentials || [];
        setCredentialRows({
          fal: rows.find((row) => row.id === 'fal') || null,
          reactor: rows.find((row) => row.id === 'reactor') || null,
          runway: rows.find((row) => row.id === 'runway') || null,
        });
      })
      .catch(() => {});
  }, []);

  useEffect(() => { refreshCredentialRows(); }, [refreshCredentialRows]);

  // Resolves true when the key was stored — the row clears its own input then.
  const saveVideoCredential = async (id, value) => {
    const trimmed = value.trim();
    if (!trimmed) return false;
    setVideoCredentialBusy(`${id}-saving`);
    const row = await saveCredential(id, trimmed, { silent: true }).catch(() => null);
    setVideoCredentialBusy(null);
    if (!row) { toast.error('Failed to save key'); return false; }
    setCredentialRows((previous) => ({ ...previous, [id]: row }));
    toast.success('Key saved privately.');
    return true;
  };

  const clearVideoCredential = async (id) => {
    setVideoCredentialBusy(`${id}-clearing`);
    const row = await saveCredential(id, '', { silent: true }).catch(() => null);
    setVideoCredentialBusy(null);
    if (!row) { toast.error('Failed to clear key'); return; }
    setCredentialRows((previous) => ({ ...previous, [id]: row }));
    toast.success('Saved key cleared. External credentials may still apply.');
  };

  const { load } = form;
  useEffect(() => {
    let active = true;
    setLoading(true);
    setLoadError(false);
    Promise.all([getSettings({ silent: true }), getToolsList({ silent: true })])
      .then(([s, tools]) => {
        if (!active) return;
        const loaded = mediaFormFromSettings(s);
        setParallelBounds(loaded.bounds);
        load(loaded.values);
        setToolRegistered(tools.some((t) => t.id === SDAPI_TOOL_ID));
        setCodexToolRegistered(tools.some((t) => t.id === CODEX_TOOL_ID));
        setGrokToolRegistered(tools.some((t) => t.id === GROK_TOOL_ID));
        setAgyToolRegistered(tools.some((t) => t.id === AGY_TOOL_ID));
      })
      .catch(() => { if (active) setLoadError(true); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [load, loadAttempt]);

  // Probe the provider whose tab is open (undefined → the saved default
  // backend). Every result is tagged with the tab that asked for it and only
  // rendered under that tab, so neither a tab switch nor a probe still in
  // flight can show one provider's answer under another provider's panel.
  const activeTab = MEDIA_TABS.find((t) => t.id === mediaTab);
  const probeMode = activeTab?.probeMode;

  const checkStatus = useCallback(() => {
    setChecking(true);
    getImageGenStatus(probeMode)
      .then((result) => setStatus({ ...result, forTab: mediaTab }))
      .catch(() => setStatus({ connected: false, reason: 'Check failed', forTab: mediaTab }))
      .finally(() => setChecking(false));
  }, [probeMode, mediaTab]);
  const statusReadiness = imageGenReadiness(status);
  const statusReady = statusReadiness === 'ready';
  const statusUnknown = statusReadiness === 'unknown';
  // The Local tab's own verdict, for the model IT has pinned — independent of
  // `status`, which follows whichever backend tab is active. Probed from the
  // drawer's first render so the verdict is ready when the Local tab opens.
  const localRuntime = useLocalImageRuntime(values.localModelId || LOCAL_IMAGEGEN_DEFAULT_MODEL);

  const handleSave = async () => {
    setSaving(true);
    const next = normalizeMediaForm(values, parallelBounds);
    try {
      // One request per changed slice, in order, so the server's write queue
      // merges each against the freshest persisted settings. A failure part
      // way leaves `saved` untouched: the next save re-sends the same
      // (idempotent) patches.
      for (const [slicePath, partial] of diffSlicePatches(next, saved)) {
        await patchSettingsSlice(slicePath, partial, { silent: true });
      }
      // Acknowledge this submission without replacing edits made while its
      // requests were pending. Untouched fields still adopt normalization.
      form.markSaved(next, values);
      toast.success('Image gen settings saved');
    } catch (err) {
      toast.error(err.message || 'Failed to save settings');
      setSaving(false);
      return;
    }

    // Both tool entries are independent — sync them in parallel so a
    // tailnet save doesn't pay two sequential HTTP round-trips.
    const { mode, pythonPath, codexEnabled, grokEnabled, agyEnabled } = next;
    const url = next.sdapiUrl || undefined;
    const sdEnabled = mode === IMAGE_GEN_MODE.EXTERNAL ? !!url
      : (mode === IMAGE_GEN_MODE.LOCAL ? isLocalImageConfigured({ pythonPath, modelId: next.localModelId }) : false);
    const sdToolData = {
      name: mode === IMAGE_GEN_MODE.EXTERNAL ? 'Stable Diffusion (External)' : (mode === IMAGE_GEN_MODE.LOCAL ? 'Stable Diffusion (Local mflux)' : 'Stable Diffusion'),
      category: 'image-generation',
      description: 'Generate images via the active PortOS image gen backend',
      enabled: sdEnabled,
      config: { mode, sdapiUrl: url, pythonPath },
      promptHints: 'Use POST /api/image-gen/generate with { prompt, negativePrompt, width, height, steps }. Use POST /api/image-gen/avatar for character portraits.',
    };
    const grokToolData = {
      name: 'Grok Imagegen',
      category: 'image-generation',
      description: 'Generate images via the Grok Build CLI built-in image_gen tool. Requires a Grok plan that includes image generation.',
      enabled: grokEnabled,
      config: { grokPath: next.grokPath || undefined, aspectRatio: next.grokAspectRatio || undefined },
      promptHints: 'Use POST /api/image-gen/generate with { prompt, mode: "grok" } — or call the image_generate voice tool with provider: "grok".',
    };
    const codexToolData = {
      name: 'Codex Imagegen',
      category: 'image-generation',
      description: 'Generate images via the Codex CLI built-in image_gen tool ($imagegen prompt prefix). Requires a Codex plan that includes image_gen.',
      enabled: codexEnabled,
      config: { codexPath: next.codexPath || undefined, model: next.codexModel || undefined, effort: next.codexEffort || undefined },
      promptHints: 'Use POST /api/image-gen/generate with { prompt, mode: "codex" } — or call the image_generate voice tool with provider: "codex".',
    };
    const agyToolData = {
      name: 'Agy Imagegen',
      category: 'image-generation',
      description: 'Generate text-to-image renders through the Antigravity CLI generate_image tool.',
      enabled: agyEnabled,
      config: { agyPath: next.agyPath || undefined, model: next.agyModel || undefined },
      promptHints: 'Use POST /api/image-gen/generate with { prompt, mode: "agy" } — or call image_generate with provider: "agy". Image editing is not supported.',
    };

    const syncTool = async ({ id, registered, data, shouldCreate, onCreated, errLabel }) => {
      if (registered) {
        return updateTool(id, data, { silent: true }).catch((err) => toast.error(err.message || `Failed to update ${errLabel}`));
      }
      if (shouldCreate) {
        try {
          await registerTool({ id, ...data }, { silent: true });
          onCreated?.();
        } catch (err) {
          toast.error(err.message || `Failed to register ${errLabel}`);
        }
      }
    };

    await Promise.all([
      syncTool({
        id: SDAPI_TOOL_ID, registered: toolRegistered, data: sdToolData,
        shouldCreate: sdEnabled, onCreated: () => setToolRegistered(true),
        errLabel: 'CoS tools registry',
      }),
      syncTool({
        id: CODEX_TOOL_ID, registered: codexToolRegistered, data: codexToolData,
        shouldCreate: codexEnabled, onCreated: () => setCodexToolRegistered(true),
        errLabel: 'Codex Imagegen tool',
      }),
      syncTool({
        id: GROK_TOOL_ID, registered: grokToolRegistered, data: grokToolData,
        shouldCreate: grokEnabled, onCreated: () => setGrokToolRegistered(true),
        errLabel: 'Grok Imagegen tool',
      }),
      syncTool({
        id: AGY_TOOL_ID, registered: agyToolRegistered, data: agyToolData,
        shouldCreate: agyEnabled, onCreated: () => setAgyToolRegistered(true),
        errLabel: 'Agy Imagegen tool',
      }),
    ]);

    setSaving(false);
  };

  if (loading) return <BrailleSpinner text="Loading image gen settings" />;
  if (loadError) return <LoadFailedState
    title="Could not load image generation settings"
    hint="Retry to load your saved configuration."
    onRetry={() => setLoadAttempt(attempt => attempt + 1)}
  />;

  return (
    <div className="space-y-4">
      {/* Sub-navigation — groups this long settings surface into tabs so no
          single scroll is page-length. Internal to the component so it renders
          identically inside a plain Drawer or the Settings page. */}
      <TabPills
        tabs={MEDIA_TABS}
        activeTab={mediaTab}
        onChange={setMediaTab}
        variant="pills"
        mobileCompact
        ariaLabel="Media generation settings sections"
        controlsIdPrefix="media-settings-tabpanel"
      />

      <div
        id={`media-settings-tabpanel-${mediaTab}`}
        role="tabpanel"
        aria-labelledby={`tab-${mediaTab}`}
        className="space-y-5"
      >
        <ImageGenBackendSections
          mediaTab={mediaTab}
          form={form}
          credentials={{ rows: credentialRows, busy: videoCredentialBusy, save: saveVideoCredential, clear: clearVideoCredential }}
        />
        <ImageGenProviderSections
          mediaTab={mediaTab}
          setMediaTab={setMediaTab}
          form={form}
          parallelBounds={parallelBounds}
          runwayCredential={credentialRows.runway}
          falCredential={credentialRows.fal}
          localRuntime={localRuntime}
          onStatusRecheck={checkStatus}
        />
        <ImageGenServiceSections mediaTab={mediaTab} form={form} />
      </div>

      {/* Persistent global save + status bar — applies across every tab since
          Save persists the whole imageGen config. Test Connection probes the
          provider whose tab is open (falling back to the saved default backend
          on the non-provider tabs). Kept outside the tab panel so it's
          reachable no matter which section is open. */}
      <div className="flex items-center gap-3 pt-3 border-t border-port-border">
        <button
          type="button"
          onClick={handleSave}
          disabled={saving || !isDirty}
          className="flex items-center gap-2 px-4 py-2 bg-port-accent hover:bg-port-accent/80 text-white text-sm rounded-lg transition-colors disabled:opacity-50 min-h-[40px]"
        >
          {saving ? <BrailleSpinner /> : <Save size={14} />}
          Save
        </button>
        <button
          type="button"
          onClick={checkStatus}
          disabled={checking || isDirty}
          className="flex items-center gap-2 px-4 py-2 bg-port-border hover:bg-port-border/70 text-white text-sm rounded-lg transition-colors disabled:opacity-50 min-h-[40px]"
          title={isDirty
            ? 'Save settings first to test'
            : `Probe ${probeMode ? activeTab.label : 'the active backend'}`}
        >
          {checking ? <BrailleSpinner /> : <Zap size={14} />}
          Test Connection
        </button>
        {status?.forTab === mediaTab && (
          <span className={`text-sm ${statusReady ? 'text-port-success' : statusUnknown ? 'text-port-warning' : 'text-port-error'}`}>
            {statusReady
              ? `Ready — ${status.mode} — ${status.model || status.pythonPath}`
              : `${statusUnknown ? 'Could not verify' : 'Unavailable'} — ${status.reason || 'Not connected'}`}
          </span>
        )}
      </div>

      {/* CoS integration footer */}
      <div className="text-xs text-gray-500 px-1 flex items-center gap-2">
        {toolRegistered && (
          <>
            <Wrench className="w-3 h-3" />
            Registered as CoS tool — agents can use this backend for briefings, avatars, and visual content.
          </>
        )}
      </div>
    </div>
  );
}

export default ImageGenTab;
