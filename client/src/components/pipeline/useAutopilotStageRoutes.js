import { useCallback, useEffect, useMemo, useState } from 'react';
import { getPipelineAutopilotModelMetrics } from '../../services/apiPipeline.js';
import { getProviders } from '../../services/apiProviders.js';
import { resolveSeriesRunLlm } from '../../utils/providers';
import { resolveInheritedLlmRoute } from './autopilotLlmRoute';

const EMPTY_ROUTE = {};

export default function useAutopilotStageRoutes(series) {
  const seriesId = series?.id;
  // Per-run provider/model override. '' = "use the series default", i.e. the
  // provider picked in the series header (`series.llm`), falling back to the
  // install's active provider — the same chain the server resolves in
  // resolveAutopilotLlm, so the copy below names what will actually run. Per-run
  // only (never persisted, like the readiness gate): pinning a different model
  // for one run must not silently re-point every other action on the series.
  const [providerOverride, setProviderOverride] = useState('');
  const [modelOverride, setModelOverride] = useState('');
  // Per-run reasoning effort (#3641). Same per-run-only contract as the
  // provider/model pin: '' = "use whatever the provider's config already bakes
  // in". Sent as `effortOverride`, which the server threads as a SOFT run-level
  // default — a stage with its own `effort` pin still wins.
  const [effortOverride, setEffortOverride] = useState('');
  // Optional independent critic route for this run. Creation/repair keeps the
  // run default above; judges, verification and analytical editorial passes use
  // this route. Exact prompt-stage pins still win over both soft defaults.
  const [separateJudgeLlm, setSeparateJudgeLlm] = useState(false);
  const [judgeProviderOverride, setJudgeProviderOverride] = useState('');
  const [judgeModelOverride, setJudgeModelOverride] = useState('');
  const [judgeEffortOverride, setJudgeEffortOverride] = useState('');
  // Optional routes scoped to one Autopilot step + role. This is the UI side of
  // the model-performance loop: a user can pin a proven specialist (or run an
  // experiment) without repointing every creative or judge call in the run.
  const [stageLlm, setStageLlm] = useState({});
  const [editStageLlm, setEditStageLlm] = useState(false);
  const [selectedStageLlm, setSelectedStageLlm] = useState('foundationGate');
  const [selectedStageRole, setSelectedStageRole] = useState('creative');
  const [providers, setProviders] = useState([]);
  const [activeProviderId, setActiveProviderId] = useState(null);
  const [modelMetrics, setModelMetrics] = useState(null);
  const [productionScope, setProductionScope] = useState('series');

  // Resume restores the saved production scope and LLM overrides together.
  const { status, resumeOptions } = series?.autopilot || EMPTY_ROUTE;
  const resumeJudge = resumeOptions?.judgeLlm;
  useEffect(() => {
    const resume = status === 'paused' ? resumeOptions : null;
    setProductionScope(resume?.productionScope || 'series');
    setProviderOverride(resume?.providerOverride || '');
    setModelOverride(resume?.modelOverride || '');
    setEffortOverride(resume?.effortOverride || '');
    setSeparateJudgeLlm(!!resume?.judgeLlm);
    setJudgeProviderOverride(resume?.judgeLlm?.providerOverride || '');
    setJudgeModelOverride(resume?.judgeLlm?.modelOverride || '');
    setJudgeEffortOverride(resume?.judgeLlm?.effortOverride || '');
    setStageLlm(resume?.stageLlm || {});
    setEditStageLlm(!!resume?.stageLlm && Object.keys(resume.stageLlm).length > 0);
  }, [
    seriesId,
    status,
    resumeOptions?.productionScope,
    resumeOptions?.providerOverride,
    resumeOptions?.modelOverride,
    resumeOptions?.effortOverride,
    resumeJudge?.providerOverride,
    resumeJudge?.modelOverride,
    resumeJudge?.effortOverride,
    resumeOptions?.stageLlm,
  ]);

  useEffect(() => {
    let canceled = false;
    getProviders({ silent: true })
      .then((data) => {
        if (canceled) return;
        setProviders(data?.providers || []);
        setActiveProviderId(data?.activeProvider || null);
      })
      .catch(() => null); // picker degrades to the "series default" option only
    return () => { canceled = true; };
  }, []);

  useEffect(() => {
    let canceled = false;
    getPipelineAutopilotModelMetrics(seriesId, { silent: true })
      .then((data) => { if (!canceled) setModelMetrics(data); })
      .catch(() => null);
    return () => { canceled = true; };
  }, [seriesId]);


  // Effective provider/model this run will use: per-run override → series.llm →
  // active provider (the client mirror of the server's resolveAutopilotLlm), so
  // the Options copy names what will actually run.
  const seriesProviderId = series?.llm?.provider || '';
  const { provider: effProviderId, model: effModel } = resolveSeriesRunLlm(series, {
    overrideProvider: providerOverride,
    overrideModel: modelOverride,
    activeProviderId,
  });
  // What a BLANK model selection resolves to — the series model, but only while
  // the chosen provider still owns it. Names the "Series default (…)" option so
  // it can't claim a model the run wouldn't actually use.
  const { model: inheritedModel } = resolveSeriesRunLlm(series, {
    overrideProvider: providerOverride,
    activeProviderId,
  });
  const runRoute = useMemo(
    () => resolveInheritedLlmRoute(providers, {
      baseProviderId: effProviderId, baseModel: effModel, baseEffort: effortOverride,
    }),
    [providers, effProviderId, effModel, effortOverride],
  );
  // A pin naming a provider that is gone or disabled is a SOFT default server
  // side — the run quietly falls back to the active provider. Say so rather than
  // asserting a provider that won't run (only once the list has loaded, or a
  // slow fetch would flash the warning on a perfectly good pin).
  const effProvider = runRoute.provider;
  const effProviderUnavailable = !!effProviderId && providers.length > 0
    && (!effProvider || effProvider.enabled === false);
  const providerModels = runRoute.models;
  // What the picked effort ACTUALLY runs as: the server clamps a level the
  // resolved provider/model doesn't offer down its ladder, and emits no flag at
  // all for a provider with no effort control. Naming the clamped value (rather
  // than the raw pick) keeps the copy honest.
  const effectiveEffort = runRoute.effort;
  const judgeBaseEffort = judgeEffortOverride || effortOverride;
  const judgeRoute = useMemo(
    () => resolveInheritedLlmRoute(providers, {
      baseProviderId: effProviderId, baseModel: effModel, baseEffort: effortOverride,
      overrideProvider: judgeProviderOverride, overrideModel: judgeModelOverride,
      overrideEffort: judgeEffortOverride,
    }),
    [providers, effProviderId, effModel, effortOverride, judgeProviderOverride, judgeModelOverride, judgeEffortOverride],
  );
  const { providerId: judgeProviderId, model: judgeModel, models: judgeModels, effort: judgeEffort } = judgeRoute;
  const selectedStageRoute = stageLlm?.[selectedStageLlm]?.[selectedStageRole] || EMPTY_ROUTE;
  const isJudgeStage = selectedStageRole === 'judge';
  const stageBaseProviderId = isJudgeStage ? judgeProviderId : effProviderId;
  const stageBaseModel = isJudgeStage ? judgeModel : effModel;
  const stageBaseEffort = isJudgeStage ? judgeBaseEffort : effortOverride;
  const stageRoute = useMemo(
    () => resolveInheritedLlmRoute(providers, {
      baseProviderId: stageBaseProviderId, baseModel: stageBaseModel, baseEffort: stageBaseEffort,
      overrideProvider: selectedStageRoute.providerOverride, overrideModel: selectedStageRoute.modelOverride,
      overrideEffort: selectedStageRoute.effortOverride,
    }),
    [providers, stageBaseProviderId, stageBaseModel, stageBaseEffort, selectedStageRoute],
  );
  const { providerId: stageProviderId, model: stageModel, models: stageModels, effort: stageEffort } = stageRoute;
  const updateSelectedStageRoute = useCallback((patch) => {
    setStageLlm((current) => {
      const currentRoute = current?.[selectedStageLlm]?.[selectedStageRole] || {};
      const nextRoute = Object.fromEntries(
        Object.entries({ ...currentRoute, ...patch }).filter(([, value]) => !!value),
      );
      const nextStage = { ...(current?.[selectedStageLlm] || {}) };
      if (Object.keys(nextRoute).length > 0) nextStage[selectedStageRole] = nextRoute;
      else delete nextStage[selectedStageRole];
      const next = { ...current };
      if (Object.keys(nextStage).length > 0) next[selectedStageLlm] = nextStage;
      else delete next[selectedStageLlm];
      return next;
    });
  }, [selectedStageLlm, selectedStageRole]);

  // Per-run provider/model override, sent ONLY when the user picked one —
  // otherwise the server resolves the series' own llm (then the active
  // provider). Never persisted, like the readiness gate. Picking a provider
  // clears the model, so a sent model always belongs to the effective provider.
  const collectRouteOverrides = () => ({
    ...(providerOverride ? { providerOverride } : {}),
    ...(modelOverride ? { modelOverride } : {}),
    ...(effortOverride ? { effortOverride } : {}),
    ...(separateJudgeLlm && (judgeProviderOverride || judgeModelOverride || judgeEffortOverride) ? {
      judgeLlm: {
        ...(judgeProviderOverride ? { providerOverride: judgeProviderOverride } : {}),
        ...(judgeModelOverride ? { modelOverride: judgeModelOverride } : {}),
        ...(judgeEffortOverride ? { effortOverride: judgeEffortOverride } : {}),
      },
    } : {}),
    ...(Object.keys(stageLlm).length > 0 ? { stageLlm } : {}),
  });

  const customStages = Object.values(stageLlm)
    .filter((routes) => Object.values(routes || {}).some((route) => route && Object.values(route).some(Boolean))).length;

  return {
    providers, activeProviderId, productionScope, setProductionScope, collectRouteOverrides,
    runRouteFields: {
      seriesProviderId, modelMetrics, effProviderId, effModel, effectiveEffort,
      effProviderUnavailable, providerModels, inheritedModel,
      providerOverride, setProviderOverride, modelOverride, setModelOverride, effortOverride, setEffortOverride,
      separateJudgeLlm, setSeparateJudgeLlm, judgeProviderId, judgeModel, judgeEffort, judgeModels,
      judgeProviderOverride, setJudgeProviderOverride, judgeModelOverride, setJudgeModelOverride,
      judgeEffortOverride, setJudgeEffortOverride,
    },
    stageRouteFields: {
      providers, customStages, editStageLlm, setEditStageLlm, setStageLlm, selectedStageLlm, setSelectedStageLlm,
      selectedStageRole, setSelectedStageRole, selectedStageRoute, stageProviderId, stageModel, stageModels,
      stageEffort, stageBaseProviderId, stageBaseModel, updateSelectedStageRoute,
    },
  };
}
