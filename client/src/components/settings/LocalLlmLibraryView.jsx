import { useCallback, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { AlertTriangle, ExternalLink, X } from 'lucide-react';
import toast from '../ui/Toast';
import ListLoadError from '../ui/ListLoadError';
import BrailleSpinner from '../BrailleSpinner';
import { localLlmTargetKey } from '../../lib/localLlmTargetKey';
import { useConfirmDelete } from '../../hooks/useConfirmDelete';
import useDownloadPreflightConfirm from '../../hooks/useDownloadPreflightConfirm';
import useLocalLlmStatus from '../../hooks/useLocalLlmStatus';
import {
  installLocalLlmModel,
  cancelLocalLlmInstall,
  deleteLocalLlmModel,
  upgradeLocalLlmBackend,
  previewLocalLlmDownload,
} from '../../services/apiLocalLlm.js';
import { installAudioModel } from '../../services/apiMusic.js';
import { localLlmBackendLabel as labelFor } from '../../lib/localLlmBackends.js';
import CatalogBrowser from './library/CatalogBrowser';
import LocalLlmInstalledModels from './LocalLlmInstalledModels.jsx';
import DownloadPreflightConfirm from '../models/DownloadPreflightConfirm.jsx';

const btnClass = 'flex items-center gap-1.5 px-2 py-1 text-xs font-medium rounded transition-colors disabled:opacity-50';

// Find, install, compare and remove the model weights available to Ollama and
// LM Studio. Mounted only while the Model Library pill is selected, so the
// catalog is never queried for a reader who is looking at the runtimes.
export default function LocalLlmLibraryView() {
  const navigate = useNavigate();
  // id of the installed model awaiting a delete confirmation (two-step inline
  // confirm — deleting weights is an irreversible multi-GB rm -rf / DELETE).
  const { isConfirming: isConfirmingDelete, requestDelete, cancelDelete, confirmDelete } = useConfirmDelete();
  const [compareTargets, setCompareTargets] = useState([]);
  const { confirm: downloadConfirm, request: requestWeightDownload, cancel: cancelDownloadConfirm, confirmRun: runDownloadConfirm } = useDownloadPreflightConfirm();
  // Refresh the currently visible catalog after an action or a terminal socket
  // frame. The ref keeps the status hook stable while the query changes.
  const reloadCatalogRef = useRef(null);
  const reloadCatalog = useCallback(() => reloadCatalogRef.current?.(), []);
  const {
    status, statusError, loading: statusLoading, loadStatus, selected, setSelected, runAction, installBackend: installRuntimeBackend,
    actionInProgress, busy, progressMsg, setProgressMsg,
  } = useLocalLlmStatus({ onReload: reloadCatalog, inlineErrors: true });

  const selectedData = status?.[selected];
  const installedModels = selectedData?.models || [];

  // Active auto-upgrade flow (Ollama outdated → 412 on pull). Stays set while we
  // download / install / relaunch so the warning banner can show live status.
  // `{ modelId, phase: 'upgrading' | 'retrying' | 'failed', error? }`.
  const [upgradeFlow, setUpgradeFlow] = useState(null);

  // The download this tab started, for the progress banner. Audio installs
  // share the action-key prefix but are not cancelable here, so they are not set.
  const [startedDownload, setStartedDownload] = useState(null);

  const startInstall = useCallback(function startInstall(modelId, { force = false } = {}) {
    const download = { backend: selected, modelId };
    setStartedDownload(download);

    function upgradeOllamaAndRetry() {
      setUpgradeFlow({ modelId, phase: 'upgrading' });
      runAction(
        'upgrade-ollama',
        () => upgradeLocalLlmBackend('ollama'),
        (r) => r?.note ? `Ollama upgraded — ${r.note}` : 'Ollama upgraded'
      ).then((r) => {
        if (r?.success && modelId) {
          setUpgradeFlow({ modelId, phase: 'retrying' });
          startInstall(modelId);
          // The retry either succeeds (its own success toast + status reload covers
          // it) or re-enters the OLLAMA_OUTDATED branch above and resets the flow.
          // Clear after a beat so the banner doesn't linger past the retry kickoff.
          setTimeout(() => setUpgradeFlow((cur) => (cur?.phase === 'retrying' ? null : cur)), 1500);
        } else if (!r?.success) {
          setUpgradeFlow({ modelId, phase: 'failed', error: r?.error });
        }
      }).catch((err) => {
        setUpgradeFlow({ modelId, phase: 'failed', error: err?.message });
      });
    }

    // LM Studio's REST fallback queues a pending download. OLLAMA_OUTDATED
    // opens the upgrade banner, so this layer owns install notification.
    return runAction(
      `install-${modelId}`,
      () => installLocalLlmModel(selected, modelId, { silent: true, force }),
      (r) => r?.canceled ? `${modelId} download canceled` : r?.pending ? `${modelId} download started` : `${modelId} ${force ? 'redownloaded' : 'installed'}`,
      {
        onError: (err) => {
          if (err?.code === 'OLLAMA_OUTDATED' && selected === 'ollama') {
            // Don't wait for a click — just upgrade. The user already said "install
            // this model"; needing a newer Ollama to do it is an implementation
            // detail, not a separate decision.
            upgradeOllamaAndRetry();
          } else if (err?.code === 'SHARDED_GGUF') {
            // Ollama can't pull a multi-part GGUF (#5245). The catalog disables
            // Install for known-sharded quants, but a pull-by-name still lands here —
            // explain the fix rather than echoing Ollama's raw 400.
            toast.error('Ollama can’t install sharded (multi-part) GGUFs. Pick a smaller single-file quant, or install this build on LM Studio.');
          } else {
            // Any other failure: restore the default toast we suppressed.
            toast.error(err?.message || 'Install failed');
          }
        },
        clearConfirm: false
      }
    ).finally(() => setStartedDownload((cur) => (cur === download ? null : cur)));
  }, [runAction, selected]);

  const install = useCallback((modelId, opts = {}) => requestWeightDownload({
    title: opts.force ? 'Redownload local model' : 'Install local model',
    preview: () => previewLocalLlmDownload({ kind: 'install', backend: selected, modelId }, { silent: true }),
    run: () => startInstall(modelId, opts),
  }), [requestWeightDownload, selected, startInstall]);
  // Audio/music models don't run on Ollama/LM Studio — they install into the
  // shared audio-model registry (server/services/audioModels.js) via the Music
  // studio's streaming HF-download endpoint, so the Music studio picks them up.
  // The download streams SSE frames; surface progress in the same banner as the
  // socket-driven install progress; the promise owns terminal errors.
  const installAudio = useCallback((model) => {
    return runAction(
      `install-${model.id}`,
      async () => {
        await installAudioModel(
          { engine: model.engine, repo: model.repository, name: model.name },
          (ev) => {
            if (ev?.type === 'stage') setProgressMsg(ev.stage || '');
            else if (ev?.type === 'progress') setProgressMsg(`${ev.file || 'downloading'} — ${Math.round((ev.progress || 0) * 100)}%`);
          },
        );
      },
      `${model.name} installed — available in the Music studio`,
      { onError: (err) => toast.error(err?.message || 'Install failed'), clearConfirm: false },
    ).finally(() => setProgressMsg(''));
  }, [runAction, setProgressMsg]);
  const remove = (modelId) => runAction(`delete-${modelId}`, () => deleteLocalLlmModel(selected, modelId), `${modelId} deleted`)
    .then((result) => {
      // Drop the just-deleted model from any pending comparison (runAction
      // resolves undefined on failure, so only prune on a real success) — else
      // openCompare ships a dead modelId the playground would error on.
      if (!result) return;
      const key = localLlmTargetKey({ backend: selected, modelId });
      setCompareTargets((prev) => prev.filter((t) => localLlmTargetKey(t) !== key));
    });
  const toggleCompareTarget = (backend, modelId) => {
    const key = localLlmTargetKey({ backend, modelId });
    setCompareTargets((prev) => {
      if (prev.some((t) => localLlmTargetKey(t) === key)) {
        return prev.filter((t) => localLlmTargetKey(t) !== key);
      }
      if (prev.length >= 6) {
        toast.error('Compare up to 6 models at once');
        return prev;
      }
      return [...prev, { backend, modelId }];
    });
  };
  const openCompare = () => {
    const params = new URLSearchParams();
    params.set('targets', JSON.stringify(compareTargets));
    params.set('mode', 'compare');
    navigate(`/local-llm/playground?${params.toString()}`);
  };

  // Upgrade Ollama in place (direct .app download on macOS; brew elsewhere) and

  // Downloads in flight: the one this tab started (its action key) plus any the
  // server reports, so a download survives a reload with its Cancel button.
  const [cancelling, setCancelling] = useState(() => new Set());
  const downloads = useMemo(() => {
    const rows = new Map();
    for (const install of status?.installs || []) rows.set(`${install.backend}:${install.modelId}`, install);
    if (startedDownload) {
      const key = `${startedDownload.backend}:${startedDownload.modelId}`;
      if (!rows.has(key)) rows.set(key, startedDownload);
    }
    return [...rows.values()];
  }, [status?.installs, startedDownload]);
  const cancelDownload = ({ backend, modelId }) => {
    const key = `${backend}:${modelId}`;
    setCancelling((prev) => new Set(prev).add(key));
    // Not through runAction: that would replace the install's own action key.
    cancelLocalLlmInstall(backend, modelId)
      .catch(() => {})
      .finally(() => setCancelling((prev) => { const next = new Set(prev); next.delete(key); return next; }));
  };

  return (
    <section id="llm-management-panel-library" role="tabpanel" aria-labelledby="llm-library-heading" className="space-y-4">
      {downloads.length > 0 && (
        <div className="space-y-2" aria-label="Model downloads">
          {downloads.map((download) => {
            const key = `${download.backend}:${download.modelId}`;
            const detail = progressMsg && progressMsg.includes(download.modelId) ? progressMsg : null;
            const percent = Number(/(\d{1,3})%\s*$/.exec(detail || '')?.[1]);
            return (
              <div key={key} role="status" className="bg-port-card border border-port-accent/40 rounded-lg p-3 space-y-2">
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <div className="min-w-0 flex-1 text-sm text-white flex items-center gap-2">
                    <BrailleSpinner />
                    <span className="break-all">Downloading {download.modelId} on {labelFor(download.backend)}</span>
                  </div>
                  {download.cancelable !== false && <button
                    type="button"
                    onClick={() => cancelDownload(download)}
                    disabled={cancelling.has(key)}
                    className={`${btnClass} min-h-[44px] bg-port-error/20 hover:bg-port-error/30 text-port-error`}
                    title="Stop this download and delete what it had downloaded so far"
                  >
                    {cancelling.has(key) ? <BrailleSpinner /> : <X size={12} />}
                    Cancel
                  </button>}
                </div>
                {Number.isFinite(percent) && (
                  <div className="h-1.5 rounded bg-port-border overflow-hidden" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-label={`${download.modelId} download progress`}>
                    <div className="h-full bg-port-accent transition-all" style={{ width: `${percent}%` }} />
                  </div>
                )}
                {detail && <p className="text-xs text-gray-400 break-all">{detail}</p>}
              </div>
            );
          })}
        </div>
      )}
      {upgradeFlow && (
        <div className="bg-port-warning/10 border-2 border-port-warning/60 rounded-lg p-4 space-y-2" role="alert">
          <div className="flex items-start gap-3">
            <AlertTriangle size={20} className="text-port-warning mt-0.5 shrink-0" />
            <div className="flex-1 min-w-0 space-y-1">
              <p className="text-sm font-semibold text-port-warning">
                {upgradeFlow.phase === 'failed' ? 'Ollama upgrade failed' : 'Upgrading Ollama'}
              </p>
              <p className="text-xs text-gray-300">
                {upgradeFlow.phase === 'upgrading' && `${upgradeFlow.modelId} needs a newer Ollama than the one installed. Downloading the latest Ollama and replacing the installed app — this can take a minute.`}
                {upgradeFlow.phase === 'retrying' && `Ollama is up to date — retrying the ${upgradeFlow.modelId} download now.`}
                {upgradeFlow.phase === 'failed' && (upgradeFlow.error || 'See the server logs for details.')}
              </p>
              {progressMsg && upgradeFlow.phase !== 'failed' && (
                <p className="text-xs text-port-warning/90 flex items-center gap-2 pt-1">
                  <BrailleSpinner /> {progressMsg}
                </p>
              )}
              {upgradeFlow.phase === 'failed' && (
                <p className="text-xs text-gray-400 pt-1">
                  You can also upgrade manually from <a href="https://ollama.com/download" target="_blank" rel="noopener noreferrer" className="text-port-accent hover:underline inline-flex items-center gap-1">ollama.com/download <ExternalLink size={10} /></a>.
                </p>
              )}
            </div>
            {upgradeFlow.phase === 'failed' && (
              <button onClick={() => setUpgradeFlow(null)} className="text-xs text-gray-400 hover:text-white transition-colors" aria-label="Dismiss">
                Dismiss
              </button>
            )}
          </div>
        </div>
      )}
      {/* Models — backend picker + catalog/install + installed list */}
      <div className="bg-port-card border border-port-border rounded-xl p-4 sm:p-6 space-y-4">

        <CatalogBrowser
          selected={selected}
          setSelected={setSelected}
          selectedData={selectedData}
          actionInProgress={actionInProgress}
          busy={busy}
          install={install}
          installAudio={installAudio}
          installRuntimeBackend={installRuntimeBackend}
          runAction={runAction}
          reloadCatalogRef={reloadCatalogRef}
        />

        {(statusError || selectedData?.modelsError) && (
          <ListLoadError
            what={`installed ${labelFor(selected)} models`}
            error={statusError || { message: selectedData.modelsError }}
            onRetry={loadStatus}
            retrying={statusLoading}
          />
        )}
        {statusLoading && !selectedData && <BrailleSpinner text="Loading installed models" />}
        {(installedModels.length > 0 || (selectedData && !statusError && !selectedData.modelsError)) && <LocalLlmInstalledModels
          actionInProgress={actionInProgress}
          backend={selected}
          busy={busy}
          cancelDelete={cancelDelete}
          compareTargets={compareTargets}
          confirmDelete={confirmDelete}
          install={install}
          isConfirmingDelete={isConfirmingDelete}
          models={installedModels}
          onCompare={openCompare}
          onToggleCompare={toggleCompareTarget}
          remove={remove}
          requestDelete={requestDelete}
        />}
      </div>
      <DownloadPreflightConfirm
        open={Boolean(downloadConfirm)}
        title={downloadConfirm?.title}
        loading={Boolean(downloadConfirm?.loading)}
        error={downloadConfirm?.error}
        assessment={downloadConfirm?.assessment}
        confirmLabel="Start download"
        onCancel={cancelDownloadConfirm}
        onConfirm={runDownloadConfirm}
      />
    </section>
  );
}
