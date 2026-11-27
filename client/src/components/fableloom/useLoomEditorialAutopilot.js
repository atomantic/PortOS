import { useEffect, useMemo, useRef, useState } from 'react';
import toast from '../ui/Toast';
import { useAsyncAction } from '../../hooks/useAsyncAction';
import { useFableLoomRun } from '../../hooks/useFableLoomRun';
import useFableLoomAiRun from '../../hooks/useFableLoomAiRun';
import useProviderModels from '../../hooks/useProviderModels';
import {
  cancelLoomEditorialAutopilot,
  getLoom,
  getLoomEditorialAutopilotStatus,
  remediateLoomEditorial,
  reviewLoomPlaythroughs,
  startLoomEditorialAutopilot,
} from '../../services/apiFableLoom.js';
import { effectiveModelFor } from '../../utils/providers';

const ACTIVE_STATUSES = new Set(['running', 'canceling']);

const routePayload = (route) => ({
  ...(route.providerId ? { providerId: route.providerId } : {}),
  ...(route.model ? { model: route.model } : {}),
  ...(route.effort ? { effort: route.effort } : {}),
});

export default function useLoomEditorialAutopilot({ loom, onLoomUpdate }) {
  const [route, setRoute] = useState({ providerId: '', model: '', effort: '' });
  const [mode, setMode] = useState(() => loom.episodes.some((episode) => episode.nodes?.length) ? 'series' : 'planning');
  const [maxRounds, setMaxRounds] = useState(3);
  const [selfImprove, setSelfImprove] = useState(false);
  const [result, setResult] = useState(null);
  const loomIdentityRef = useRef(loom.id);
  loomIdentityRef.current = loom.id;
  const { run: autopilotRun, applyRun: setAutopilotRun, readState, readError, retry } = useFableLoomRun({
    loomId: loom.id,
    event: 'fableloom:editorial:run',
    loadRun: () => getLoomEditorialAutopilotStatus(loom.id, { silent: true }).then(response => response.run),
    onTerminal: (run, isCurrent) => {
      setResult({ type: 'autopilot', run });
      getLoom(loom.id, { silent: true }).then(updated => {
        if (isCurrent()) onLoomUpdate(updated);
      }).catch(() => {});
    },
  });
  const remediationAi = useFableLoomAiRun();
  const playtestAi = useFableLoomAiRun();
  const { providers, activeProviderId, loading: providersLoading } = useProviderModels({
    allowDefault: true,
    silent: true,
    withEffort: true,
  });
  const effectiveProviderId = route.providerId || activeProviderId;
  const selectedProvider = providers.find((provider) => provider.id === effectiveProviderId);
  const selectedModel = effectiveModelFor(selectedProvider, route.model);
  const routeBody = useMemo(() => routePayload(route), [route]);

  useEffect(() => { setResult(null); }, [loom.id]);

  const autopilotActive = ACTIVE_STATUSES.has(autopilotRun?.status);
  useEffect(() => {
    if (!ACTIVE_STATUSES.has(autopilotRun?.status)) return;
    setResult(null);
    setRoute({ providerId: autopilotRun.route?.providerId || '', model: autopilotRun.route?.model || '', effort: autopilotRun.route?.effort || '' });
    setMode(autopilotRun.mode || 'series');
    setMaxRounds(autopilotRun.maxRounds);
    setSelfImprove(autopilotRun.selfImproveEnabled === true);
  }, [autopilotRun?.id]);

  const [remediate, remediating] = useAsyncAction(async () => {
    const operationId = remediationAi.begin();
    const response = await remediateLoomEditorial(loom.id, {
      ...routeBody,
      operationId,
    }, { silent: true }).catch((error) => {
      remediationAi.fail(error.message);
      throw error;
    });
    setResult({ type: 'remediation', response });
    onLoomUpdate(response.loom);
    toast.success(response.changed
      ? `Series remediated — ${response.changes.length || 1} safe edit${response.changes.length === 1 ? '' : 's'} applied`
      : 'Series evaluated — no safe edit was needed');
  }, { errorMessage: 'Series editorial remediation failed' });

  const [runPlaytest, playtesting] = useAsyncAction(async () => {
    const operationId = playtestAi.begin();
    const response = await reviewLoomPlaythroughs(loom.id, {
      ...routeBody,
      aiReview: true,
      operationId,
    }, { silent: true }).catch((error) => {
      playtestAi.fail(error.message);
      throw error;
    });
    setResult({ type: 'playtest', response });
    toast.success(response.passed
      ? 'Every enumerated playthrough passed structural and narrative review'
      : 'Playthrough review found issues to resolve');
  }, { errorMessage: 'Playthrough test failed' });

  const [startAutopilot, startingAutopilot] = useAsyncAction(async () => {
    const run = await startLoomEditorialAutopilot(loom.id, {
      ...routeBody,
      maxRounds,
      ...(mode === 'planning' ? { mode } : {}),
      ...(selfImprove ? { selfImprove: true } : {}),
    }, { silent: true });
    if (loomIdentityRef.current !== loom.id) return;
    setResult(null);
    setAutopilotRun(run);
    toast.success(run.alreadyRunning ? 'Reattached to the active editorial autopilot' : 'Editorial autopilot started');
  }, { errorMessage: 'Could not start editorial autopilot' });

  const [cancelAutopilot, cancelingAutopilot] = useAsyncAction(async () => {
    const run = await cancelLoomEditorialAutopilot(loom.id, autopilotRun.id, { silent: true });
    setAutopilotRun(run);
  }, { errorMessage: 'Could not cancel editorial autopilot' });

  const shownRun = autopilotActive || result?.type === 'autopilot' ? autopilotRun : result ? null : autopilotRun;

  return {
    settings: {
      mode, setMode, route, setRoute, providers, providersLoading, effectiveProviderId,
      selectedProvider, selectedModel, maxRounds, setMaxRounds, selfImprove, setSelfImprove,
    },
    actions: {
      remediate, remediating, runPlaytest, playtesting, cancelAutopilot, cancelingAutopilot,
      startAutopilot, startingAutopilot, remediationRun: remediationAi.run, playtestRun: playtestAi.run,
    },
    autopilotRun,
    autopilotActive,
    readState,
    readError,
    retry,
    shownRun,
    result,
  };
}
