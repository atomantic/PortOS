import { useState, useEffect, useRef, useMemo } from 'react';
import { useSearchParams } from 'react-router';
import { FileText, Variable, RefreshCw, Save, Plus, Trash2, Eye, Briefcase, Search, X, ChevronRight, ChevronDown } from 'lucide-react';
import toast from '../components/ui/Toast';
import BrailleSpinner from '../components/BrailleSpinner';
import ProviderModelSelector from '../components/ProviderModelSelector';
import { filterSelectableModels, getProviderTimeout } from '../utils/providers';
import {
  formatDurationMs,
  parseTimeoutMs,
  TIMEOUT_INPUT_MIN_MS,
  TIMEOUT_INPUT_MAX_MS,
  TIMEOUT_INPUT_STEP_MS,
} from '../utils/formatters';
import useFieldDraft from '../hooks/useFieldDraft';
import SettingsTabsHeader from '../components/settings/SettingsTabsHeader';
import { FormField } from '../components/ui/FormField';
import Modal from '../components/ui/Modal';
import InlineConfirmRow from '../components/ui/InlineConfirmRow';
import { useConfirmDelete } from '../hooks/useConfirmDelete';
import {
  getPrompts, getPrompt, createPrompt, savePrompt, deletePrompt, previewPrompt, getPromptUsage,
  getPromptVariables, createPromptVariable, savePromptVariable, deletePromptVariable,
  getJobSkills, getJobSkill, saveJobSkill as apiSaveJobSkill, previewJobSkill as apiPreviewJobSkill,
} from '../services/apiPrompts';
import { getProviders } from '../services/apiProviders';
import Pill from '../components/ui/Pill';
import { buildStageGroups, stageGroupKeyFor } from '../lib/promptStageGroups';

const VALID_PROMPT_TABS = ['stages', 'variables', 'job-skills'];

export default function PromptManager() {
  const [searchParams, setSearchParams] = useSearchParams();
  const rawTab = searchParams.get('tab');
  const tab = VALID_PROMPT_TABS.includes(rawTab) ? rawTab : 'stages';
  const setTab = (next) => {
    const p = new URLSearchParams(searchParams);
    if (next === 'stages') p.delete('tab');
    else p.set('tab', next);
    setSearchParams(p, { replace: true });
  };
  // Selected stage / variable live in the URL (`?stage=` / `?var=`) so the open
  // record is deep-linkable and reload-safe. Unlike the `tab` param above (a view
  // toggle that uses replace), record selection is a PUSH so Back returns to the
  // previously-open record — matching Authors/Music/Sharing.
  const setParam = (key, val) => {
    const p = new URLSearchParams(searchParams);
    if (val == null || val === '') p.delete(key);
    else p.set(key, val);
    setSearchParams(p);
  };
  const selectedStage = searchParams.get('stage');
  const selectedVar = searchParams.get('var');
  const selectedJobSkill = searchParams.get('skill');
  const setSelectedStage = (name) => setParam('stage', name);
  const setSelectedVar = (key) => setParam('var', key);
  const setSelectedJobSkill = (name) => setParam('skill', name);
  const [stages, setStages] = useState({});
  // The CURATED system-stage keys. Served by GET /api/prompts
  // (`server/lib/promptSystemStages.js`) rather than mirrored client-side, so
  // the SYSTEM badge and the "System only" filter can never disagree with the
  // server's own table (#3314). This is NOT the full delete-protected set —
  // that one is wider and per-stage, and only `/usage` reports it (#3335).
  const [systemStageKeys, setSystemStageKeys] = useState([]);
  const [variables, setVariables] = useState({});
  const [loading, setLoading] = useState(true);

  // Stage list search / grouping. The query is deliberately LOCAL, not a URL
  // param: it's a transient way to reach a stage, and the thing worth
  // deep-linking (`?stage=`) is already in the URL.
  const [stageQuery, setStageQuery] = useState('');
  const [systemOnly, setSystemOnly] = useState(false);
  // Two disclosure sets, because the default flips with the filter: unfiltered,
  // groups start CLOSED and this tracks the ones opened; filtered, they start
  // OPEN (hiding a match reads as "no results") and `collapsedWhileFiltering`
  // tracks the ones folded away — a broad query like "e" matches every stage,
  // so the user still needs to be able to fold Pipeline's 78 rows out of view.
  const [expandedGroups, setExpandedGroups] = useState(() => new Set());
  const [collapsedWhileFiltering, setCollapsedWhileFiltering] = useState(() => new Set());

  // Stage editing (selection is URL-driven — see selectedStage above)
  const [stageTemplate, setStageTemplate] = useState('');
  const [stageConfig, setStageConfig] = useState({});
  const [preview, setPreview] = useState('');

  // Variable editing (selection is URL-driven — see selectedVar above)
  const [varForm, setVarForm] = useState({ key: '', name: '', category: '', content: '' });

  // Stage creation
  const [creatingStage, setCreatingStage] = useState(false);
  const [newStageForm, setNewStageForm] = useState({
    stageName: '',
    name: '',
    description: '',
    model: 'default',
    returnsJson: false,
    variables: [],
    template: ''
  });

  // Job skills (selection is URL-driven — see selectedJobSkill above)
  const [jobSkills, setJobSkills] = useState([]);
  const [jobSkillContent, setJobSkillContent] = useState('');
  // The last content the server confirmed (loaded or saved). Kept as a full copy
  // rather than a boolean flag so typing an edit and undoing it back to the
  // original stops counting as dirty — a stale flag would nag on a no-op edit.
  const [savedJobSkillContent, setSavedJobSkillContent] = useState('');
  // The skill the user clicked while holding unsaved edits, awaiting confirmation.
  const [pendingJobSkill, setPendingJobSkill] = useState(null);
  const [jobSkillMeta, setJobSkillMeta] = useState({});
  const [jobSkillPreview, setJobSkillPreview] = useState('');
  const isJobSkillDirty = Boolean(selectedJobSkill) && jobSkillContent !== savedJobSkillContent;
  // `saveJobSkill` resumes after an await holding the values its closure captured
  // at click time, so it reads the live selection/text through these refs to tell
  // "still the same editor" from "the user moved on mid-flight".
  const jobSkillLiveRef = useRef({ selected: selectedJobSkill, content: jobSkillContent });
  jobSkillLiveRef.current = { selected: selectedJobSkill, content: jobSkillContent };
  // A clean editor has nothing to discard, so an armed row disarms itself the
  // moment the edit is undone or saved — leaving the id parked would re-arm that
  // row out of nowhere the next time the user typed.
  useEffect(() => {
    if (!isJobSkillDirty) setPendingJobSkill(null);
  }, [isJobSkillDirty]);

  const [providers, setProviders] = useState([]);
  const [activeProviderId, setActiveProviderId] = useState(null);
  const [saving, setSaving] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState(null);
  // Variables delete inline-confirms in the row itself (#3935) — the trash icon
  // arms the row instead of firing DELETE on the first click.
  const {
    isConfirming: isConfirmingVar,
    requestDelete: requestVarDelete,
    cancelDelete: cancelVarDelete,
    confirmDelete: confirmVarDelete,
  } = useConfirmDelete();

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    setLoading(true);
    const [stagesRes, varsRes, jobSkillsRes, providersRes] = await Promise.all([
      getPrompts({ silent: true }).catch(() => ({ stages: {}, systemStages: [] })),
      getPromptVariables({ silent: true }).catch(() => ({ variables: {} })),
      getJobSkills({ silent: true }).catch(() => ({ skills: [] })),
      getProviders({ silent: true }).catch(() => ({ providers: [] }))
    ]);
    setStages(stagesRes.stages || {});
    // `Array.isArray` rather than `|| []`: an older server that predates the
    // `systemStages` key sends nothing, which must read as "no system stages
    // known" (no badges, empty System-only filter) — never as a crash.
    setSystemStageKeys(Array.isArray(stagesRes.systemStages) ? stagesRes.systemStages : []);
    setVariables(varsRes.variables || {});
    setJobSkills(jobSkillsRes.skills || []);
    setProviders((providersRes.providers || []).filter(p => p.enabled));
    setActiveProviderId(providersRes.activeProvider || null);
    setLoading(false);
  };

  // Fetch the URL-selected stage's template + config. Keyed on selectedStage so
  // a deep link / reload restores the open editor; a cleared param resets it.
  useEffect(() => {
    if (!selectedStage) { setStageTemplate(''); setStageConfig({}); setPreview(''); return; }
    let cancelled = false;
    getPrompt(selectedStage, { silent: true })
      .then(res => {
        if (cancelled || !res) return;
        setStageTemplate(res.template || '');
        // Normalize a server-returned timeout via parseTimeoutMs so the editor
        // shares the validator's accept set: integers OR digit-only strings
        // (e.g. legacy `'900000'` from pre-validation installs) round-trip
        // through the UI, while non-positive / non-integer / garbage values
        // (0, 'abc', undefined, 1.5) collapse to null so the input doesn't
        // surface them as touched. Only set the key when the server actually
        // shipped a value — otherwise the next save would write `timeout: null`
        // (the server's explicit-clear sentinel) for stages the user never
        // touched, conflating "key absent" with "user cleared the override".
        const cfg = { name: res.name, description: res.description, model: res.model, provider: res.provider || null, variables: res.variables || [] };
        const timeout = parseTimeoutMs(res.timeout);
        if (timeout !== null) cfg.timeout = timeout;
        setStageConfig(cfg);
        setPreview('');
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [selectedStage]);

  const saveStage = async () => {
    setSaving(true);
    const payload = { template: stageTemplate, ...stageConfig };
    // Explicitly null provider when in tier mode so server clears any previous value
    if (!payload.provider) payload.provider = null;
    const ok = await savePrompt(selectedStage, payload, { silent: true })
      .then(() => true)
      .catch((err) => { toast.error('Failed to save stage: ' + err.message); return false; });
    if (!ok) { setSaving(false); return; }
    setSaving(false);
    await loadData();
  };

  const previewStage = async () => {
    const data = await previewPrompt(selectedStage, {}, { silent: true })
      .catch((err) => { toast.error('Failed to preview: ' + err.message); return null; });
    if (!data) return;
    setPreview(data.preview);
  };

  // Hydrate the variable editor from the URL-selected key. Depends on `variables`
  // so it fills in once the list loads, but a `varHydratedRef` guard keyed on the
  // selected key ensures a later `variables` refresh (Reload, or deleting a
  // *different* variable) does NOT re-hydrate — which would silently discard the
  // open key's in-progress edits. Mirrors the hydratedRef pattern the Authors /
  // Artists editors use. No param means create mode.
  const varHydratedRef = useRef(null);
  useEffect(() => {
    if (!selectedVar) {
      varHydratedRef.current = null;
      setVarForm({ key: '', name: '', category: '', content: '' });
      return;
    }
    if (variables[selectedVar] && varHydratedRef.current !== selectedVar) {
      const v = variables[selectedVar];
      setVarForm({ key: selectedVar, name: v.name || '', category: v.category || '', content: v.content || '' });
      varHydratedRef.current = selectedVar;
    }
  }, [selectedVar, variables]);

  const saveVariable = async () => {
    setSaving(true);
    const ok = await (selectedVar
      ? savePromptVariable(selectedVar, varForm, { silent: true })
      : createPromptVariable(varForm, { silent: true }))
      .then(() => true)
      .catch((err) => { toast.error('Failed to save variable: ' + err.message); return false; });
    if (!ok) { setSaving(false); return; }
    setSaving(false);
    setSelectedVar(null);
    setVarForm({ key: '', name: '', category: '', content: '' });
    await loadData();
  };

  const deleteVariable = async (key) => {
    const ok = await deletePromptVariable(key, { silent: true })
      .then(() => true)
      .catch((err) => { toast.error('Failed to delete variable: ' + err.message); return false; });
    if (!ok) return;
    if (selectedVar === key) setSelectedVar(null);
    await loadData();
  };

  const newVariable = () => {
    setSelectedVar(null);
    setVarForm({ key: '', name: '', category: '', content: '' });
  };

  const createStage = async () => {
    setSaving(true);
    const payload = { ...newStageForm };
    // Strip provider field when in tier mode
    if (!payload.provider) delete payload.provider;
    const ok = await createPrompt(payload, { silent: true })
      .then(() => true)
      .catch((err) => { setSaving(false); toast.error(err.message || 'Failed to create stage'); return false; });
    if (!ok) return;

    setSaving(false);
    setCreatingStage(false);
    setNewStageForm({
      stageName: '',
      name: '',
      description: '',
      model: 'default',
      returnsJson: false,
      variables: [],
      template: ''
    });
    await loadData();
  };

  const requestDeleteStage = async (stageName) => {
    // Check if stage is in use. On failure fall back to "deletable" rather
    // than "protected" — a false `canDelete: false` would silently force-delete
    // a user stage, while a false `true` just lets the server's own guard
    // return SYSTEM_STAGE_PROTECTED, which the toast surfaces.
    const usageRes = await getPromptUsage(stageName, { silent: true })
      .catch(() => ({ isSystemStage: false, usedBy: [], referencedBy: [], canDelete: true }));

    setDeleteConfirm({ stageName, ...usageRes });
  };

  const confirmDeleteStage = async () => {
    const { stageName, canDelete } = deleteConfirm;
    setDeleteConfirm(null);

    // The server refuses without ?force=true for BOTH the curated system set
    // and any stage its source references by name (#3335), so gate on
    // `canDelete` — `isSystemStage` alone would 400 on a pipeline stage.
    const ok = await deletePrompt(stageName, { force: canDelete === false }, { silent: true })
      .then(() => true)
      .catch((err) => { toast.error(`Failed to delete: ${err.message || 'Unknown error'}`); return false; });

    if (!ok) return;

    if (selectedStage === stageName) {
      setSelectedStage(null);
    }
    await loadData();
  };

  // Fetch the URL-selected job skill's template + meta. Keyed on selectedJobSkill
  // so a deep link / reload / tab switch restores the open editor; a cleared
  // param resets it. Mirrors the `selectedStage` effect above.
  // Content/meta/preview are cleared up front rather than on the way out, so an
  // in-flight fetch (or one that 404s on a stale deep link) can never leave the
  // PREVIOUS skill's template rendered under the newly selected skill's heading.
  useEffect(() => {
    setJobSkillPreview('');
    setJobSkillContent('');
    setSavedJobSkillContent('');
    setPendingJobSkill(null);
    setJobSkillMeta({});
    if (!selectedJobSkill) return;
    let cancelled = false;
    getJobSkill(selectedJobSkill, { silent: true })
      .then((res) => {
        if (cancelled || !res) return;
        setJobSkillContent(res.content || '');
        setSavedJobSkillContent(res.content || '');
        setJobSkillMeta({ jobName: res.jobName, jobId: res.jobId, category: res.category, interval: res.interval });
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [selectedJobSkill]);

  // A failed save must say so: the button re-enabling on its own reads as
  // "saved" and the edit is silently lost. `silent: true` + an explicit toast
  // keeps the notification to one layer (see client/src/CLAUDE.md).
  const saveJobSkill = async () => {
    setSaving(true);
    // Snapshot what we actually sent — the textarea may change while the PATCH
    // is in flight, and only the persisted text may become the clean baseline.
    // The skill is snapshotted too: if the editor has moved on by the time the
    // PUT resolves, `sent` belongs to the PREVIOUS skill and adopting it as the
    // baseline would flag the freshly loaded one as dirty.
    const sent = jobSkillContent;
    const sentFor = selectedJobSkill;
    const ok = await apiSaveJobSkill(sentFor, sent, { silent: true })
      .then(() => true)
      .catch((err) => { toast.error(`Failed to save job skill: ${err.message || 'Unknown error'}`); return false; });
    setSaving(false);
    if (!ok) return;
    const live = jobSkillLiveRef.current;
    if (sentFor === live.selected) {
      setSavedJobSkillContent(sent);
      // Saving answers the pending discard prompt — there is nothing left to
      // lose, unless the user kept typing while the PUT was open.
      if (sent === live.content) setPendingJobSkill(null);
    }
    toast.success('Job skill saved');
  };

  // Switching skills replaces the editor's content, so unsaved edits must be
  // confirmed away first (#3939). The clicked skill parks in `pendingJobSkill`
  // and an inline confirm row takes over its list slot — no window.confirm.
  const requestJobSkill = (name) => {
    if (name === selectedJobSkill) {
      // Re-clicking the open skill is how a user backs out of the prompt from
      // the list side; leaving it armed would strand the row mid-question.
      setPendingJobSkill(null);
      return;
    }
    if (isJobSkillDirty) {
      setPendingJobSkill(name);
      return;
    }
    switchJobSkill(name);
  };

  // Content is cleared in the same tick as the selection, not left to the
  // `selectedJobSkill` effect — otherwise the frame between the two renders the
  // OUTGOING skill's text and dirty badges under the incoming skill's row.
  const switchJobSkill = (name) => {
    setPendingJobSkill(null);
    setJobSkillContent('');
    setSavedJobSkillContent('');
    setSelectedJobSkill(name);
  };

  const previewJobSkill = async () => {
    const previewFor = selectedJobSkill;
    const res = await apiPreviewJobSkill(previewFor, { silent: true })
      .catch((err) => { toast.error(`Failed to preview: ${err.message || 'Unknown error'}`); return null; });
    if (!res) return;
    // A preview that lands after the user moved on belongs to the previous
    // skill — rendering it under the new one's heading would misattribute it.
    if (previewFor !== jobSkillLiveRef.current.selected) return;
    setJobSkillPreview(res.preview || '');
  };

  const getModelsForProvider = (providerId) => {
    const p = providers.find(pr => pr.id === providerId);
    return p ? filterSelectableModels(p.models || [p.defaultModel]) : [];
  };

  const stageFilterActive = stageQuery.trim() !== '' || systemOnly;
  const { groups: stageGroups, matchCount: stageMatchCount, totalCount: stageTotalCount } = useMemo(
    () => buildStageGroups(stages, { query: stageQuery, systemOnly, systemStageKeys }),
    [stages, stageQuery, systemOnly, systemStageKeys],
  );
  // Badge lookup for the row render — a Set so the O(n) list render doesn't
  // re-scan the key array per row.
  const systemStageSet = useMemo(() => new Set(systemStageKeys), [systemStageKeys]);

  // The group holding the open stage expands itself so a deep link / reload
  // lands with its row visible. Seeding STATE (rather than forcing it open at
  // render time) keeps the user free to collapse it again afterwards.
  const selectedGroupKey = selectedStage && stages[selectedStage]
    ? stageGroupKeyFor(selectedStage, stages[selectedStage])
    : null;
  useEffect(() => {
    if (!selectedGroupKey) return;
    setExpandedGroups((prev) => new Set(prev).add(selectedGroupKey));
  }, [selectedGroupKey]);

  // A fold is scoped to the EXACT filter that motivated it, not merely to
  // "some filter is on". Carrying it across a refinement is how the refined
  // query's only hit ends up behind a collapsed header — the "reads as no
  // results" failure this whole disclosure default exists to avoid.
  const stageQueryKey = stageQuery.trim();
  useEffect(() => {
    setCollapsedWhileFiltering((prev) => (prev.size === 0 ? prev : new Set()));
  }, [stageQueryKey, systemOnly]);

  const toggleInSet = (set, key) => {
    const next = new Set(set);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  };
  const toggleGroup = (key) => (stageFilterActive
    ? setCollapsedWhileFiltering((prev) => toggleInSet(prev, key))
    : setExpandedGroups((prev) => toggleInSet(prev, key)));

  if (loading) {
    return (
      <div className="flex flex-col h-full">
        <div className="flex items-center gap-3 p-4 border-b border-port-border">
          <h1 className="text-2xl font-bold text-white">Settings</h1>
        </div>
        <SettingsTabsHeader activeTab="prompts" />
        <div className="flex-1 flex items-center justify-center">
          <BrailleSpinner text="Loading prompts" />
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-3 p-4 border-b border-port-border">
        <h1 className="text-2xl font-bold text-white">Settings</h1>
      </div>

      <SettingsTabsHeader activeTab="prompts" />

      <div className="flex-1 overflow-auto p-4">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
        <div>
          <h1 className="text-2xl font-bold text-white">Prompt Manager</h1>
          <p className="text-gray-500 text-sm sm:text-base">Customize AI prompts for backend operations</p>
        </div>
        <button
          onClick={loadData}
          className="p-2 text-gray-400 hover:text-white self-end sm:self-auto"
          title="Reload" aria-label="Reload"
        >
          <RefreshCw size={20} />
        </button>
      </div>

      {/* Tabs */}
      <div className="flex flex-wrap gap-2 mb-6">
        <button
          onClick={() => setTab('stages')}
          className={`flex items-center gap-2 px-3 sm:px-4 py-2 rounded-lg transition-colors text-sm sm:text-base ${
            tab === 'stages' ? 'bg-port-accent text-white' : 'bg-port-card text-gray-400 hover:text-white'
          }`}
        >
          <FileText size={16} /> Stages
        </button>
        <button
          onClick={() => setTab('variables')}
          className={`flex items-center gap-2 px-3 sm:px-4 py-2 rounded-lg transition-colors text-sm sm:text-base ${
            tab === 'variables' ? 'bg-port-accent text-white' : 'bg-port-card text-gray-400 hover:text-white'
          }`}
        >
          <Variable size={16} /> Variables
        </button>
        <button
          onClick={() => setTab('job-skills')}
          className={`flex items-center gap-2 px-3 sm:px-4 py-2 rounded-lg transition-colors text-sm sm:text-base ${
            tab === 'job-skills' ? 'bg-port-accent text-white' : 'bg-port-card text-gray-400 hover:text-white'
          }`}
        >
          <Briefcase size={16} /> Job Skills
        </button>
      </div>

      {/* Stages Tab */}
      {tab === 'stages' && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Stage List */}
          <div className="bg-port-card border border-port-border rounded-xl p-4">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-medium text-gray-400">Prompt Stages</h3>
              <button
                onClick={() => setCreatingStage(true)}
                className="p-1 text-port-accent hover:text-port-accent/80"
                title="New Stage" aria-label="New Stage"
              >
                <Plus size={16} />
              </button>
            </div>
            {/* Search + SYSTEM filter, pinned above the list so it stays
                reachable while the grouped rows scroll. */}
            <div className="sticky top-0 z-10 -mx-4 px-4 pb-3 bg-port-card">
              <div className="relative">
                <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 pointer-events-none" />
                <input
                  type="search"
                  aria-label="Search prompt stages"
                  value={stageQuery}
                  onChange={(e) => setStageQuery(e.target.value)}
                  placeholder="Search stages…"
                  // WebKit paints its own cancel glyph on a non-empty
                  // type=search, which would sit on top of the labelled clear
                  // button below; Tailwind's preflight resets only
                  // ::-webkit-search-decoration, so suppress it here.
                  className="w-full pl-8 pr-9 py-2.5 bg-port-bg border border-port-border rounded-lg text-sm text-white placeholder:text-gray-500 focus:border-port-accent focus:outline-hidden [&::-webkit-search-cancel-button]:appearance-none"
                />
                {stageQuery && (
                  <button
                    onClick={() => setStageQuery('')}
                    aria-label="Clear stage search"
                    className="absolute right-1 top-1/2 -translate-y-1/2 p-2 text-gray-500 hover:text-white"
                  >
                    <X size={14} />
                  </button>
                )}
              </div>
              <div className="flex items-center justify-between gap-2 mt-2">
                <button
                  onClick={() => setSystemOnly(v => !v)}
                  aria-pressed={systemOnly}
                  className={`text-[10px] px-2.5 py-1.5 rounded uppercase font-semibold transition-colors ${
                    systemOnly
                      ? 'bg-port-accent text-white'
                      : 'bg-port-border text-gray-400 hover:text-white'
                  }`}
                >
                  System only
                </button>
                <span className="text-xs text-gray-500">
                  {stageFilterActive ? `${stageMatchCount} of ${stageTotalCount}` : `${stageTotalCount} stages`}
                </span>
              </div>
            </div>
            <div className="space-y-1">
              {stageGroups.map(({ key: groupKey, label, stages: groupStages }) => {
                // A filter flips the default open — hits hidden behind collapsed
                // headers read as "no results" — but the toggle stays live so a
                // broad query's biggest group can still be folded away.
                const open = stageFilterActive
                  ? !collapsedWhileFiltering.has(groupKey)
                  : expandedGroups.has(groupKey);
                const Chevron = open ? ChevronDown : ChevronRight;
                return (
                  <div key={groupKey}>
                    <button
                      onClick={() => toggleGroup(groupKey)}
                      aria-expanded={open}
                      // Without this the name computes to "Pipeline78" — the
                      // count span abuts the label with no separator.
                      aria-label={`${label}, ${groupStages.length} stage${groupStages.length === 1 ? '' : 's'}`}
                      className="w-full flex items-center gap-1 px-2 py-2 rounded-lg text-xs font-semibold uppercase tracking-wide text-gray-400 hover:bg-port-border hover:text-white"
                    >
                      <Chevron size={12} className="shrink-0" />
                      <span className="min-w-0 truncate">{label}</span>
                      <span className="ml-auto shrink-0 text-gray-500 normal-case">{groupStages.length}</span>
                    </button>
                    {open && (
                      <div className="space-y-1 pl-2">
                        {groupStages.map(([name, config]) => (
                          <button
                            key={name}
                            onClick={() => setSelectedStage(name)}
                            className={`w-full text-left px-3 py-2 rounded-lg text-sm ${
                              selectedStage === name
                                ? 'bg-port-accent/20 text-port-accent'
                                : 'text-gray-300 hover:bg-port-border'
                            }`}
                          >
                            <div className="flex items-center gap-1">
                              <span className="font-medium truncate">{config.name || name}</span>
                              {systemStageSet.has(name) && (
                                <Pill tone="bare" size="xs" bordered={false} className="shrink-0 bg-port-accent/20 text-port-accent uppercase font-semibold">
                                  System
                                </Pill>
                              )}
                            </div>
                            <div className="text-xs text-gray-500 truncate">{config.description}</div>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
              {stageGroups.length === 0 && (
                <div className="text-sm text-gray-500 px-3 py-2">
                  {stageFilterActive ? 'No stages match that search' : 'No prompt stages found'}
                </div>
              )}
            </div>
          </div>

          {/* Stage Editor */}
          <div className="lg:col-span-2 space-y-4">
            {selectedStage && !stages[selectedStage] ? (
              <div className="bg-port-card border border-port-border rounded-xl p-12 text-center text-gray-500">
                That stage could not be found — it may have been deleted or renamed.{' '}
                <button onClick={() => setSelectedStage(null)} className="text-port-accent hover:underline">
                  Clear selection
                </button>
              </div>
            ) : selectedStage ? (
              <>
                <div className="bg-port-card border border-port-border rounded-xl p-4">
                  <div className="flex items-center justify-between mb-4">
                    <h3 className="text-lg font-medium text-white">{stageConfig.name}</h3>
                    <div className="flex gap-2">
                      <button
                        onClick={previewStage}
                        className="flex items-center gap-1 px-3 py-1 text-sm bg-port-border hover:bg-port-border/80 text-white rounded"
                      >
                        <Eye size={14} /> Preview
                      </button>
                      <button
                        onClick={saveStage}
                        disabled={saving}
                        className="flex items-center gap-1 px-3 py-1 text-sm bg-port-accent hover:bg-port-accent/80 text-white rounded disabled:opacity-50"
                      >
                        <Save size={14} /> Save
                      </button>
                      {/* Delete lives here, not on the list row: a destructive
                          control sitting beside 120+ select targets is a
                          mis-tap waiting to happen (#3284). */}
                      <button
                        onClick={() => requestDeleteStage(selectedStage)}
                        title="Delete stage"
                        className="flex items-center gap-1 px-3 py-1 text-sm bg-port-border hover:bg-port-error text-gray-300 hover:text-white rounded"
                      >
                        <Trash2 size={14} /> Delete
                      </button>
                    </div>
                  </div>

                  <div className="space-y-4 mb-4">
                    <div>
                      <div className="flex items-center gap-2 mb-2">
                        <label className="text-sm text-gray-400">Model</label>
                        <div className="flex gap-1">
                          <button
                            onClick={() => setStageConfig({ ...stageConfig, provider: null, model: 'default' })}
                            className={`px-2 py-1 text-xs rounded transition-colors ${!stageConfig.provider ? 'bg-port-accent text-white' : 'bg-port-border text-gray-400 hover:text-white'}`}
                          >
                            Tier
                          </button>
                          <button
                            onClick={() => {
                              if (stageConfig.provider) return;
                              const first = providers[0];
                              setStageConfig({ ...stageConfig, provider: first?.id || '', model: first?.defaultModel || '' });
                            }}
                            disabled={providers.length === 0}
                            className={`px-2 py-1 text-xs rounded transition-colors ${stageConfig.provider ? 'bg-port-accent text-white' : 'bg-port-border text-gray-400 hover:text-white'} disabled:opacity-50`}
                          >
                            Specific
                          </button>
                        </div>
                      </div>
                      {!stageConfig.provider ? (
                        <select
                          aria-label="Model tier"
                          value={stageConfig.model || 'default'}
                          onChange={(e) => setStageConfig({ ...stageConfig, model: e.target.value })}
                          className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-hidden"
                        >
                          <option value="default">Default</option>
                          <option value="quick">Quick</option>
                          <option value="coding">Coding</option>
                          <option value="heavy">Heavy</option>
                        </select>
                      ) : (
                        <ProviderModelSelector
                          providers={providers}
                          selectedProviderId={stageConfig.provider}
                          selectedModel={stageConfig.model}
                          availableModels={getModelsForProvider(stageConfig.provider)}
                          onProviderChange={(id) => {
                            const p = providers.find(pr => pr.id === id);
                            setStageConfig({ ...stageConfig, provider: id, model: p?.defaultModel || '' });
                          }}
                          onModelChange={(model) => setStageConfig({ ...stageConfig, model })}
                        />
                      )}
                    </div>
                    <StageTimeoutField
                      timeout={stageConfig.timeout}
                      providerFallback={getProviderTimeout(providers, stageConfig.provider, activeProviderId)}
                      onCommit={(ms) => setStageConfig({ ...stageConfig, timeout: ms })}
                    />
                    <div>
                      <label className="block text-sm text-gray-400 mb-1">Variables Used</label>
                      <div className="text-sm text-gray-300">
                        {(stageConfig.variables || []).join(', ') || 'None'}
                      </div>
                    </div>
                  </div>

                  <FormField label="Template">
                    <textarea
                      value={stageTemplate}
                      onChange={(e) => setStageTemplate(e.target.value)}
                      className="w-full h-96 px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white font-mono text-sm focus:border-port-accent focus:outline-hidden"
                    />
                    <p className="text-xs text-gray-500 mt-1">
                      Use {'{{variable}}'} for substitution, {'{{#array}}...{{/array}}'} for iteration
                    </p>
                  </FormField>
                </div>

                {/* Preview Panel */}
                {preview && (
                  <div className="bg-port-card border border-port-border rounded-xl p-4">
                    <h4 className="text-sm font-medium text-gray-400 mb-2">Preview</h4>
                    <pre className="text-sm text-gray-300 whitespace-pre-wrap bg-port-bg p-3 rounded max-h-64 overflow-auto">
                      {preview}
                    </pre>
                  </div>
                )}

              </>
            ) : (
              <div className="bg-port-card border border-port-border rounded-xl p-12 text-center text-gray-500">
                Select a stage to edit
              </div>
            )}
          </div>
        </div>
      )}

      {/* Variables Tab */}
      {tab === 'variables' && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Variable List */}
          <div className="bg-port-card border border-port-border rounded-xl p-4">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-medium text-gray-400">Variables</h3>
              <button
                onClick={newVariable}
                aria-label="Add variable"
                className="p-1 text-port-accent hover:text-port-accent/80"
              >
                <Plus size={16} />
              </button>
            </div>
            <div className="space-y-1">
              {Object.entries(variables).sort(([a], [b]) => a.localeCompare(b)).map(([key, v]) => (
                isConfirmingVar(key) ? (
                  <InlineConfirmRow
                    key={key}
                    className="rounded-lg"
                    question={`Delete "${v.name || key}"?`}
                    confirmText="Delete"
                    aria-label={`Confirm delete variable ${v.name || key}`}
                    autoFocus
                    onConfirm={() => confirmVarDelete(() => deleteVariable(key))}
                    onCancel={cancelVarDelete}
                  />
                ) : (
                  <div
                    key={key}
                    className={`flex items-center justify-between px-3 py-2 rounded-lg text-sm ${
                      selectedVar === key
                        ? 'bg-port-accent/20 text-port-accent'
                        : 'text-gray-300 hover:bg-port-border'
                    }`}
                  >
                    <button
                      onClick={() => setSelectedVar(key)}
                      className="flex-1 text-left"
                    >
                      <div className="font-medium">{v.name || key}</div>
                      <div className="text-xs text-gray-500">{v.category || 'uncategorized'}</div>
                    </button>
                    <button
                      onClick={() => requestVarDelete(key)}
                      aria-label={`Delete variable ${v.name || key}`}
                      className="p-1 text-gray-500 hover:text-port-error"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                )
              ))}
            </div>
          </div>

          {/* Variable Editor */}
          <div className="lg:col-span-2">
            {selectedVar && !variables[selectedVar] ? (
              <div className="bg-port-card border border-port-border rounded-xl p-12 text-center text-gray-500">
                That variable could not be found — it may have been deleted.{' '}
                <button onClick={() => setSelectedVar(null)} className="text-port-accent hover:underline">
                  New variable
                </button>
              </div>
            ) : (
            <div className="bg-port-card border border-port-border rounded-xl p-4">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-medium text-white">
                  {selectedVar ? `Edit: ${selectedVar}` : 'New Variable'}
                </h3>
                <button
                  onClick={saveVariable}
                  disabled={saving || !varForm.key || !varForm.content}
                  className="flex items-center gap-1 px-3 py-1 text-sm bg-port-accent hover:bg-port-accent/80 text-white rounded disabled:opacity-50"
                >
                  <Save size={14} /> Save
                </button>
              </div>

              <div className="space-y-4">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <FormField label="Key *">
                    <input
                      type="text"
                      value={varForm.key}
                      onChange={(e) => setVarForm({ ...varForm, key: e.target.value })}
                      disabled={!!selectedVar}
                      placeholder="variableKey"
                      className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-hidden disabled:opacity-50"
                    />
                  </FormField>
                  <FormField label="Name">
                    <input
                      type="text"
                      value={varForm.name}
                      onChange={(e) => setVarForm({ ...varForm, name: e.target.value })}
                      placeholder="Human Readable Name"
                      className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-hidden"
                    />
                  </FormField>
                </div>

                <FormField label="Category">
                  <select
                    value={varForm.category}
                    onChange={(e) => setVarForm({ ...varForm, category: e.target.value })}
                    className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-hidden"
                  >
                    <option value="">Select category</option>
                    <option value="response">Response Format</option>
                    <option value="schema">Schema</option>
                    <option value="rules">Rules</option>
                    <option value="system">System</option>
                  </select>
                </FormField>

                <FormField label="Content *">
                  <textarea
                    value={varForm.content}
                    onChange={(e) => setVarForm({ ...varForm, content: e.target.value })}
                    className="w-full h-48 px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white font-mono text-sm focus:border-port-accent focus:outline-hidden"
                    placeholder="Variable content..."
                  />
                </FormField>
              </div>
            </div>
            )}
          </div>
        </div>
      )}

      {/* Job Skills Tab */}
      {tab === 'job-skills' && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Job Skill List */}
          <div className="bg-port-card border border-port-border rounded-xl p-4">
            <div className="mb-3">
              <h3 className="text-sm font-medium text-gray-400">Autonomous Job Skills</h3>
              <p className="text-xs text-gray-500 mt-1">Versioned prompt templates for recurring jobs</p>
            </div>
            <div className="space-y-1">
              {jobSkills.map((skill) => (
                // The dirty check is part of the render condition, not just of
                // arming: undoing the edit back to the saved text while the row
                // is armed leaves nothing to discard, so the question must go.
                (pendingJobSkill === skill.name && isJobSkillDirty) ? (
                  <InlineConfirmRow
                    key={skill.name}
                    className="rounded-lg"
                    question={`Discard unsaved changes to "${jobSkillMeta.jobName || selectedJobSkill}"?`}
                    confirmText="Discard"
                    cancelText="Keep editing"
                    aria-label={`Confirm discarding unsaved changes to ${jobSkillMeta.jobName || selectedJobSkill}`}
                    autoFocus
                    onConfirm={() => switchJobSkill(skill.name)}
                    onCancel={() => setPendingJobSkill(null)}
                  />
                ) : (
                  <button
                    key={skill.name}
                    onClick={() => requestJobSkill(skill.name)}
                    className={`w-full text-left px-3 py-2 rounded-lg text-sm ${
                      selectedJobSkill === skill.name
                        ? 'bg-port-accent/20 text-port-accent'
                        : 'text-gray-300 hover:bg-port-border'
                    }`}
                  >
                    <div className="flex items-center gap-1">
                      <span className="font-medium">{skill.name}</span>
                      {skill.hasTemplate && (
                        <span className="shrink-0 text-[10px] px-1.5 py-0.5 bg-port-success/20 text-port-success rounded uppercase font-semibold">
                          Active
                        </span>
                      )}
                      {selectedJobSkill === skill.name && isJobSkillDirty && (
                        <span className="shrink-0 text-[10px] px-1.5 py-0.5 bg-port-warning/20 text-port-warning rounded uppercase font-semibold">
                          Unsaved
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-gray-500">{skill.jobId}</div>
                  </button>
                )
              ))}
              {jobSkills.length === 0 && (
                <div className="text-sm text-gray-500 px-3 py-2">No job skill templates found</div>
              )}
            </div>
          </div>

          {/* Job Skill Editor */}
          <div className="lg:col-span-2 space-y-4">
            {selectedJobSkill ? (
              <>
                <div className="bg-port-card border border-port-border rounded-xl p-4">
                  <div className="flex items-center justify-between mb-4">
                    <div>
                      <h3 className="text-lg font-medium text-white">{jobSkillMeta.jobName || selectedJobSkill}</h3>
                      <div className="flex gap-3 text-xs text-gray-500 mt-1">
                        {jobSkillMeta.category && <span>Category: {jobSkillMeta.category}</span>}
                        {jobSkillMeta.interval && <span>Interval: {jobSkillMeta.interval}</span>}
                        {jobSkillMeta.jobId && <span>ID: {jobSkillMeta.jobId}</span>}
                        {isJobSkillDirty && <span className="text-port-warning">Unsaved changes</span>}
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <button
                        onClick={previewJobSkill}
                        className="flex items-center gap-1 px-3 py-1 text-sm bg-port-border hover:bg-port-border/80 text-white rounded"
                      >
                        <Eye size={14} /> Preview
                      </button>
                      <button
                        onClick={saveJobSkill}
                        disabled={saving}
                        className="flex items-center gap-1 px-3 py-1 text-sm bg-port-accent hover:bg-port-accent/80 text-white rounded disabled:opacity-50"
                      >
                        <Save size={14} /> Save
                      </button>
                    </div>
                  </div>

                  <FormField label="Skill Template (Markdown)">
                    <textarea
                      value={jobSkillContent}
                      onChange={(e) => setJobSkillContent(e.target.value)}
                      className="w-full h-96 px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white font-mono text-sm focus:border-port-accent focus:outline-hidden"
                    />
                    <p className="text-xs text-gray-500 mt-1">
                      Sections: ## Prompt Template, ## Steps, ## Expected Outputs, ## Success Criteria
                    </p>
                  </FormField>
                </div>

                {/* Preview Panel */}
                {jobSkillPreview && (
                  <div className="bg-port-card border border-port-border rounded-xl p-4">
                    <h4 className="text-sm font-medium text-gray-400 mb-2">Effective Prompt Preview</h4>
                    <pre className="text-sm text-gray-300 whitespace-pre-wrap bg-port-bg p-3 rounded max-h-64 overflow-auto">
                      {jobSkillPreview}
                    </pre>
                  </div>
                )}
              </>
            ) : (
              <div className="bg-port-card border border-port-border rounded-xl p-12 text-center text-gray-500">
                <p>Select a job skill to edit its prompt template</p>
                <p className="text-xs mt-2">These templates define how recurring autonomous jobs execute</p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Create Stage Modal */}
      <Modal
        open={creatingStage}
        onClose={() => setCreatingStage(false)}
        size="lg"
        backdropClassName="bg-black/50"
        closeOnBackdrop={false}
        ariaLabelledBy="create-stage-title"
      >
        <div className="bg-port-card border border-port-border rounded-xl p-6 max-h-[90vh] overflow-y-auto">
          <div className="flex items-center justify-between mb-4">
            <h3 id="create-stage-title" className="text-lg font-medium text-white">Create New Stage</h3>
            <button
              onClick={() => setCreatingStage(false)}
              aria-label="Close"
              className="text-gray-400 hover:text-white min-h-[44px] min-w-[44px] flex items-center justify-center"
            >
              ✕
            </button>
          </div>

            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <FormField label="Stage Key *">
                  <input
                    type="text"
                    value={newStageForm.stageName}
                    onChange={(e) => setNewStageForm({ ...newStageForm, stageName: e.target.value })}
                    placeholder="my-stage"
                    className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-hidden"
                  />
                  <p className="text-xs text-gray-500 mt-1">Lowercase, hyphens only</p>
                </FormField>
                <FormField label="Display Name *">
                  <input
                    type="text"
                    value={newStageForm.name}
                    onChange={(e) => setNewStageForm({ ...newStageForm, name: e.target.value })}
                    placeholder="Pipeline — My Stage"
                    className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-hidden"
                  />
                  <p className="text-xs text-gray-500 mt-1">
                    Name it <span className="text-gray-400">Family — Specific</span> to file it under an existing group
                  </p>
                </FormField>
              </div>

              <FormField label="Description">
                <input
                  type="text"
                  value={newStageForm.description}
                  onChange={(e) => setNewStageForm({ ...newStageForm, description: e.target.value })}
                  placeholder="What this stage does"
                  className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-hidden"
                />
              </FormField>

              <div className="space-y-4">
                <div>
                  <div className="flex items-center gap-2 mb-2">
                    <label className="text-sm text-gray-400">Model</label>
                    <div className="flex gap-1">
                      <button
                        type="button"
                        onClick={() => setNewStageForm({ ...newStageForm, provider: undefined, model: 'default' })}
                        className={`px-2 py-1 text-xs rounded transition-colors ${!newStageForm.provider ? 'bg-port-accent text-white' : 'bg-port-border text-gray-400 hover:text-white'}`}
                      >
                        Tier
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          if (newStageForm.provider) return;
                          const first = providers[0];
                          setNewStageForm({ ...newStageForm, provider: first?.id || '', model: first?.defaultModel || '' });
                        }}
                        disabled={providers.length === 0}
                        className={`px-2 py-1 text-xs rounded transition-colors ${newStageForm.provider ? 'bg-port-accent text-white' : 'bg-port-border text-gray-400 hover:text-white'} disabled:opacity-50`}
                      >
                        Specific
                      </button>
                    </div>
                  </div>
                  {!newStageForm.provider ? (
                    <select
                      aria-label="Model tier"
                      value={newStageForm.model}
                      onChange={(e) => setNewStageForm({ ...newStageForm, model: e.target.value })}
                      className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-hidden"
                    >
                      <option value="default">Default</option>
                      <option value="quick">Quick</option>
                      <option value="coding">Coding</option>
                      <option value="heavy">Heavy</option>
                    </select>
                  ) : (
                    <ProviderModelSelector
                      providers={providers}
                      selectedProviderId={newStageForm.provider}
                      selectedModel={newStageForm.model}
                      availableModels={getModelsForProvider(newStageForm.provider)}
                      onProviderChange={(id) => {
                        const p = providers.find(pr => pr.id === id);
                        setNewStageForm({ ...newStageForm, provider: id, model: p?.defaultModel || '' });
                      }}
                      onModelChange={(model) => setNewStageForm({ ...newStageForm, model })}
                    />
                  )}
                </div>
                <div>
                  <label className="flex items-center gap-2 text-sm text-gray-400">
                    <input
                      type="checkbox"
                      checked={newStageForm.returnsJson}
                      onChange={(e) => setNewStageForm({ ...newStageForm, returnsJson: e.target.checked })}
                      className="rounded"
                    />
                    Returns JSON
                  </label>
                </div>
              </div>

              <FormField label="Template">
                <textarea
                  value={newStageForm.template}
                  onChange={(e) => setNewStageForm({ ...newStageForm, template: e.target.value })}
                  className="w-full h-64 px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white font-mono text-sm focus:border-port-accent focus:outline-hidden"
                  placeholder="Enter your prompt template here..."
                />
              </FormField>

              <div className="flex gap-2 justify-end">
                <button
                  onClick={() => setCreatingStage(false)}
                  className="px-4 py-2 text-gray-400 hover:text-white"
                >
                  Cancel
                </button>
                <button
                  onClick={createStage}
                  disabled={saving || !newStageForm.stageName || !newStageForm.name}
                  className="flex items-center gap-1 px-4 py-2 bg-port-accent hover:bg-port-accent/80 text-white rounded disabled:opacity-50"
                >
                  <Save size={14} /> Create Stage
                </button>
              </div>
            </div>
          </div>
      </Modal>

      {/* Delete Stage Confirmation Modal */}
      <Modal
        open={!!deleteConfirm}
        onClose={() => setDeleteConfirm(null)}
        size="sm"
        backdropClassName="bg-black/50"
        ariaLabelledBy="delete-stage-title"
      >
        <div className="bg-port-card border border-port-border rounded-xl p-6">
          <h3 id="delete-stage-title" className="text-lg font-medium text-white mb-3">
            {deleteConfirm?.canDelete === false
              ? (deleteConfirm.isSystemStage ? 'Delete System Stage?' : 'Delete Referenced Stage?')
              : 'Delete Stage?'}
          </h3>
          {/* Protected covers both the curated SYSTEM set and any stage the
              server's source references by name — the latter is badge-less but
              just as breakable, so it gets the same warning plus the files
              that name it (#3335). */}
          {deleteConfirm?.canDelete === false ? (
            <div className="space-y-2 mb-6">
              <p className="text-port-warning text-sm font-medium">
                "{deleteConfirm.stageName}" is {deleteConfirm.isSystemStage ? 'a system stage' : 'referenced by PortOS source'}.
              </p>
              {deleteConfirm.usedBy?.length > 0 && (
                <p className="text-gray-400 text-sm">Used by: {deleteConfirm.usedBy.join(', ')}</p>
              )}
              {deleteConfirm.referencedBy?.length > 0 && (
                <div className="text-gray-400 text-sm">
                  <p className="mb-1">Referenced in:</p>
                  <ul className="max-h-32 overflow-y-auto space-y-0.5 font-mono text-xs break-all">
                    {deleteConfirm.referencedBy.map((path) => <li key={path}>{path}</li>)}
                  </ul>
                </div>
              )}
              <p className="text-gray-400 text-sm">Deleting this will break PortOS functionality.</p>
            </div>
          ) : (
            <p className="text-gray-400 text-sm mb-6">
              Delete "{deleteConfirm?.stageName}"? This cannot be undone.
            </p>
          )}
          <div className="flex gap-2 justify-end">
            <button
              onClick={() => setDeleteConfirm(null)}
              className="px-4 py-2 text-gray-400 hover:text-white"
            >
              Cancel
            </button>
            <button
              onClick={confirmDeleteStage}
              className="px-4 py-2 bg-port-error hover:bg-port-error/80 text-white rounded"
            >
              Delete
            </button>
          </div>
        </div>
      </Modal>
      </div>
    </div>
  );
}

// Buffered timeout input — typing "9" toward "900000" must NOT snap the field
// to blank just because `parseTimeoutMs("9")` returns null (below the 1s
// floor). useFieldDraft keeps the raw string locally and only invokes
// onCommit on blur with the validated value (or null when the user clears
// it / leaves it invalid).
function StageTimeoutField({ timeout, providerFallback, onCommit }) {
  const { value: draft, onChange, onBlur } = useFieldDraft(timeout, (raw) => {
    const trimmed = raw.trim();
    if (trimmed === '') { onCommit(null); return; }
    const ms = parseTimeoutMs(raw);
    // Non-null parse → commit. Null result on non-empty input means out-of-range
    // or non-integer; leave persisted state untouched so the input snaps back.
    if (ms != null) onCommit(ms);
  });
  return (
    <FormField label="Timeout override (ms)">
      <input
        type="number"
        inputMode="numeric"
        min={TIMEOUT_INPUT_MIN_MS}
        max={TIMEOUT_INPUT_MAX_MS}
        step={TIMEOUT_INPUT_STEP_MS}
        value={draft}
        onChange={onChange}
        onBlur={onBlur}
        onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
        placeholder={providerFallback != null ? String(providerFallback) : ''}
        className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-hidden"
      />
      <p className="text-xs text-gray-500 mt-1">
        {timeout && timeout > 0
          ? `≈ ${formatDurationMs(timeout)} per run`
          : 'Leave blank to use the provider default'}
      </p>
    </FormField>
  );
}
