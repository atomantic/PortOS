import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { Activity, ArrowLeft, Box, Boxes, ClipboardCopy, Clapperboard, Columns2, FileCode, Hammer, Images, SlidersHorizontal, Square } from 'lucide-react';
import PageHeader from '../components/PageHeader';
import PageLayout from '../components/PageLayout';
import PageSkeleton from '../components/ui/PageSkeleton';
import TabPills from '../components/ui/TabPills';
import ListLoadError from '../components/ui/ListLoadError';
import { FilmApiContext } from '../components/musicVideo/blender/FilmApiContext.jsx';
import BlenderFilesTab from '../components/musicVideo/blender/BlenderFilesTab.jsx';
import BlenderModelTab from '../components/blenderModels/BlenderModelTab.jsx';
import BlenderModelReferencesTab from '../components/blenderModels/BlenderModelReferencesTab.jsx';
import BlenderModelCompareTab from '../components/blenderModels/BlenderModelCompareTab.jsx';
import BlenderModelBuildsTab from '../components/blenderModels/BlenderModelBuildsTab.jsx';
import BlenderModelSettingsTab from '../components/blenderModels/BlenderModelSettingsTab.jsx';
import BlenderModelReadiness from '../components/blenderModels/BlenderModelReadiness.jsx';
import useBlenderModel, { BLENDER_MODEL_FILM_API } from '../components/blenderModels/useBlenderModel.js';
import { buttonCls, primaryCls } from '../components/musicVideo/blender/blenderStyles.js';
import { useValidTab } from '../hooks/useValidTab';
import useUrlParams from '../hooks/useUrlParams';
import { useSocketResource } from '../hooks/useSocketResource';
import { getBlenderModelBuildReport } from '../services/apiBlenderModels.js';
import { createShowcaseFilm } from '../services/apiCodeAnimationFilm.js';
import toast from '../components/ui/Toast';
import { BLENDER_MODEL_TABS, blenderModelAgentBrief, blenderModelBuilds, blenderModelStatusMeta, shownBlenderModelBuild } from '../lib/blenderModels.js';
import { copyToClipboard } from '../lib/clipboard.js';

const TABS = [
  { id: 'model', label: 'Model', icon: Box },
  { id: 'references', label: 'References', icon: Images },
  { id: 'compare', label: 'Compare', icon: Columns2 },
  { id: 'files', label: 'Files', icon: FileCode },
  { id: 'builds', label: 'Builds', icon: Activity },
  { id: 'settings', label: 'Settings', icon: SlidersHorizontal },
];
const FILES_COPY = {
  empty: <>No source files yet. Create the starter script under Model, or add <code className="font-mono">model.py</code> below.</>,
  binary: 'It is used by the model but cannot be edited here.',
  hint: 'Select a text file to read or edit it. Saving writes it to the workspace; nothing runs until you build.',
  newFile: 'model.py',
};
const NO_EVENTS = [];

/** One Blender model (`/3d/blender/:id/:tab?`): review the build, edit the source, build, publish. Selection lives in the URL. */
export default function BlenderModelDetail() {
  const { id } = useParams();
  return <BlenderModelPage key={id} id={id} />;
}

function BlenderModelPage({ id }) {
  const navigate = useNavigate();
  const tab = useValidTab(BLENDER_MODEL_TABS, 'model');
  const [params, updateParams] = useUrlParams();
  const [makingFilm, setMakingFilm] = useState(false);
  const model = useBlenderModel(id);
  const { state, pending, buildBlocker } = model;
  const requestedBuild = params.get('build');
  const build = shownBlenderModelBuild(state, requestedBuild);
  // A build's report never changes, so it is read once per build.
  const report = useSocketResource(({ signal }) => getBlenderModelBuildReport(id, build.id, { silent: true, signal }),
    { resourceKey: build?.id ?? null, enabled: !!build, events: NO_EVENTS });
  // The other selections (build, part, open file, open log) stay in the URL across tabs.
  const openTab = (next, patch = {}) => {
    const search = new URLSearchParams(params);
    for (const [key, value] of Object.entries(patch)) search.set(key, value);
    navigate({ pathname: `/3d/blender/${encodeURIComponent(id)}/${next}`, search: search.toString() });
  };

  // Starts no job: it makes an editable film from the published build and opens it.
  const makeShowcaseFilm = async () => {
    setMakingFilm(true);
    const film = await createShowcaseFilm(id).catch((err) => {
      if (err?.code !== 'HOST_CONTROL_FORBIDDEN') toast.error(err?.message || 'Could not make the showcase film');
      return null;
    });
    setMakingFilm(false);
    if (film) navigate(`/code-animation/production/films/${encodeURIComponent(film.id)}`);
  };

  if (!state) {
    if (model.loading) return <PageSkeleton header="bar" label="Loading Blender model" tabs={4} sidebar={false} />;
    return (
      <PageLayout header={<PageHeader icon={Boxes} title="Blender model" />}>
        {model.error ? <ListLoadError what="this model" error={model.error} onRetry={model.refetch} /> : <p className="text-sm text-gray-400">This model no longer exists.</p>}
        <Link to="/3d" className={`${buttonCls} mt-3`}><ArrowLeft size={14} aria-hidden="true" /> Back to 3D</Link>
      </PageLayout>
    );
  }

  const newest = blenderModelBuilds(state)[0] || null;
  const building = state.status === 'building';
  const runningBuild = blenderModelBuilds(state).find((entry) => entry.status === 'running');
  const status = blenderModelStatusMeta(state.status);
  const actions = (
    <>
      <span className={`text-xs ${status.className}`}>{status.label}</span>
      <button type="button" className={buttonCls} onClick={() => copyToClipboard(blenderModelAgentBrief(state, { report: report.data }), 'Agent brief copied')}>
        <ClipboardCopy size={14} aria-hidden="true" /> Copy agent brief
      </button>
      {state.publishedBuildId && (
        <button type="button" className={buttonCls} disabled={makingFilm} onClick={makeShowcaseFilm}>
          <Clapperboard size={14} aria-hidden="true" /> {makingFilm ? 'Making film…' : 'Make showcase film'}
        </button>
      )}
      {building && runningBuild ? (
        <button type="button" className={buttonCls} disabled={!!pending[`cancel:${runningBuild.id}`]} onClick={() => model.cancelBuild(runningBuild.id)}>
          <Square size={14} aria-hidden="true" /> {pending[`cancel:${runningBuild.id}`] ? 'Canceling…' : 'Cancel build'}
        </button>
      ) : (
        <>
          <button type="button" className={primaryCls} disabled={!!buildBlocker} onClick={() => model.build('draft')}>
            <Hammer size={14} aria-hidden="true" /> {pending.build ? 'Starting…' : 'Build draft'}
          </button>
          <button type="button" className={buttonCls} disabled={!!buildBlocker} onClick={() => model.build('full')}>Build full</button>
        </>
      )}
    </>
  );

  return (
    <FilmApiContext.Provider value={BLENDER_MODEL_FILM_API}>
      <PageLayout
        header={<PageHeader icon={Boxes} title={state.name} subtitle={state.description || 'Blender model'} actions={actions} />}
        navigation={<TabPills tabs={TABS} activeTab={tab} onChange={(next) => openTab(next)} mobileCompact ariaLabel="Blender model" runningKind={building ? 'builds' : null} />}
        bodyClassName="overflow-auto space-y-3 p-4 md:p-6"
      >
        <Link to="/3d" className={buttonCls}><ArrowLeft size={14} aria-hidden="true" /> Back to 3D</Link>
        {model.error && (
          <ListLoadError what="the latest state. What is shown may be out of date" error={model.error} onRetry={model.refetch} />
        )}
        {tab !== 'settings' && <BlenderModelReadiness tool={state.tool} quiet />}
        {/* Readiness, a missing script (Model's own empty state) and a running build explain themselves elsewhere. */}
        {buildBlocker && state.tool.ready && state.workspace.hasModel && !building && !pending.build && tab !== buildBlocker.tab && (
          <p role="status" className="flex min-w-0 flex-wrap items-center gap-2 text-xs text-port-warning">
            <span className="min-w-0">{buildBlocker.message}</span>
            <button type="button" className={buttonCls} onClick={() => openTab(buildBlocker.tab)}>Open {buildBlocker.tab}</button>
          </p>
        )}
        {newest?.status === 'failed' && (
          <div role="alert" className="flex min-w-0 flex-wrap items-center gap-2 rounded border border-port-error/30 bg-port-error/5 p-2 text-xs text-port-error">
            <span className="min-w-0 flex-1 break-words">The newest build failed: {newest.error || 'see its log.'}</span>
            {tab !== 'builds' && <button type="button" className={buttonCls} onClick={() => openTab('builds', { log: newest.id })}>Open build log</button>}
          </div>
        )}
        {state.workspace.srcChanged && !building && (
          <p role="status" className="text-xs text-port-text-muted">The source changed since the newest completed build. Build again to see it.</p>
        )}
        <div role="tabpanel" aria-label={TABS.find((entry) => entry.id === tab).label} className="min-w-0">
          {tab === 'model' && (
            <BlenderModelTab model={model} build={build} part={params.get('part')} onOpenTab={openTab}
              reportRead={{ data: report.data, error: report.error, retry: report.refetch }}
              onPartChange={(part) => updateParams({ part }, { replace: true })}
              onBuildChange={(next) => updateParams({ build: next })} />
          )}
          {tab === 'references' && <BlenderModelReferencesTab model={model} onOpenTab={openTab} />}
          {tab === 'compare' && <BlenderModelCompareTab model={model} build={build} report={report.data} params={params} updateParams={updateParams} onOpenTab={openTab} />}
          {tab === 'files' && <BlenderFilesTab blender={model} copy={FILES_COPY} />}
          {tab === 'builds' && (
            <BlenderModelBuildsTab model={model} openBuildId={params.get('log')} onOpenLog={(next) => updateParams({ log: next }, { replace: true })}
              onReview={(buildId) => openTab('model', { build: buildId })} />
          )}
          {tab === 'settings' && <BlenderModelSettingsTab model={model} />}
        </div>
      </PageLayout>
    </FilmApiContext.Provider>
  );
}
