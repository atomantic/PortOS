import { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { RefreshCw, Compass, CheckCircle, ArrowRight, FolderSearch, FileText, Map, Play, Terminal } from 'lucide-react';
import toast from 'react-hot-toast';
import BrailleSpinner from '../../BrailleSpinner';
import GsdProjectHeader from '../../gsd/GsdProjectHeader';
import PhaseCardList from '../../gsd/PhaseCardList';
import GsdConcernsPanel from '../../cos/tabs/GsdConcernsPanel';
import GsdDocumentsPanel from '../../gsd/GsdDocumentsPanel';
import * as api from '../../../services/api';

const STEP_DESCRIPTIONS = {
  map: 'Run the /gsd:map-codebase skill to analyze the codebase structure',
  project: 'Run the /gsd:new-project skill to initialize the project with deep context gathering',
  roadmap: 'Run the /gsd:plan-phase skill to create a roadmap with phase breakdown and execution plans',
};

function GsdSetupGuide({ gsd, appId, repoPath, onRefresh }) {
  const [runningStep, setRunningStep] = useState(null);

  // Determine the current step based on what exists
  const steps = [
    {
      id: 'map',
      label: 'Map Codebase',
      command: '/gsd:map-codebase',
      description: 'Analyze your codebase structure with parallel mapper agents',
      done: gsd.hasCodebaseMap,
      icon: FolderSearch,
    },
    {
      id: 'project',
      label: 'Create Project',
      command: '/gsd:new-project',
      description: 'Initialize project with deep context gathering and PROJECT.md',
      done: gsd.hasProject,
      icon: FileText,
    },
    {
      id: 'roadmap',
      label: 'Plan Phases',
      command: '/gsd:plan-phase',
      description: 'Create a roadmap with phase breakdown and execution plans',
      done: gsd.hasRoadmap,
      icon: Map,
    },
  ];

  const currentStepIdx = steps.findIndex(s => !s.done);
  const currentStep = currentStepIdx >= 0 ? steps[currentStepIdx] : null;

  const handleRunStep = async (step) => {
    setRunningStep(step.id);
    await api.addCosTask({
      description: STEP_DESCRIPTIONS[step.id],
      app: appId,
      priority: 'MEDIUM',
    }).catch(() => null);
    toast.success('Agent task created');
    setTimeout(() => setRunningStep(null), 2000);
  };

  const handleOpenClaude = async () => {
    toast('Opening Claude Code...');
    await api.openAppInClaude(appId).catch(() => null);
  };

  return (
    <div className="max-w-5xl">
      <div className="bg-port-card border border-port-border rounded-lg p-6">
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <Compass size={24} className="text-port-accent" />
            <div>
              <h3 className="text-lg font-semibold text-white">GSD Project Setup</h3>
              <p className="text-sm text-gray-500">Follow the steps below to initialize GSD project tracking</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {repoPath && (
              <button
                onClick={handleOpenClaude}
                className="px-3 py-1.5 bg-purple-600/20 hover:bg-purple-600/30 text-purple-400 rounded-lg text-xs flex items-center gap-1 border border-purple-600/30"
              >
                <Terminal size={14} /> Open Claude Code
              </button>
            )}
            <button
              onClick={onRefresh}
              className="px-3 py-1.5 bg-port-border hover:bg-port-border/80 text-white rounded-lg text-xs flex items-center gap-1"
            >
              <RefreshCw size={14} /> Refresh
            </button>
          </div>
        </div>

        {/* Step indicators */}
        <div className="space-y-3">
          {steps.map((step, idx) => {
            const Icon = step.icon;
            const isCurrent = idx === currentStepIdx;
            const isFuture = currentStepIdx >= 0 && idx > currentStepIdx;

            return (
              <div
                key={step.id}
                className={`flex items-center gap-4 p-4 rounded-lg border ${
                  step.done
                    ? 'border-port-success/30 bg-port-success/5'
                    : isCurrent
                      ? 'border-port-accent/50 bg-port-accent/5'
                      : 'border-port-border bg-port-bg/50 opacity-50'
                }`}
              >
                <div className={`flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center ${
                  step.done
                    ? 'bg-port-success/20 text-port-success'
                    : isCurrent
                      ? 'bg-port-accent/20 text-port-accent'
                      : 'bg-port-border text-gray-500'
                }`}>
                  {step.done ? <CheckCircle size={18} /> : <Icon size={18} />}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className={`text-sm font-medium ${step.done ? 'text-port-success' : isCurrent ? 'text-white' : 'text-gray-500'}`}>
                      {step.label}
                    </span>
                    {step.done && <span className="text-xs text-port-success">Complete</span>}
                  </div>
                  <p className="text-xs text-gray-500 mt-0.5">{step.description}</p>
                </div>
                {isCurrent && (
                  <div className="flex items-center gap-2 flex-shrink-0">
                    <code className="text-sm text-cyan-400 bg-port-bg px-2 py-1 rounded">{step.command}</code>
                    <button
                      onClick={() => handleRunStep(step)}
                      disabled={runningStep === step.id}
                      className="px-3 py-1.5 bg-port-accent/20 hover:bg-port-accent/30 text-port-accent rounded-lg text-xs flex items-center gap-1 border border-port-accent/30 disabled:opacity-50"
                    >
                      <Play size={14} /> {runningStep === step.id ? 'Created' : 'Run'}
                    </button>
                  </div>
                )}
                {isFuture && !step.done && (
                  <code className="text-xs text-gray-600 bg-port-bg px-2 py-1 rounded flex-shrink-0">{step.command}</code>
                )}
              </div>
            );
          })}
        </div>

        {currentStep && (
          <p className="text-xs text-gray-500 mt-4">
            Click <strong className="text-gray-400">Run</strong> to create a CoS agent task, or run <code className="text-cyan-400">{currentStep.command}</code> in Claude Code manually.
          </p>
        )}
      </div>
    </div>
  );
}

function NextActionBanner({ pendingActions, appId }) {
  const [triggering, setTriggering] = useState(false);

  if (!pendingActions?.length) return null;

  // Show the first pending action
  const action = pendingActions[0];
  const actionLabels = {
    plan: { label: 'Plan', desc: 'Create a detailed execution plan', style: 'border-port-warning/30 bg-port-warning/5' },
    execute: { label: 'Execute', desc: 'Execute the plan for this phase', style: 'border-port-accent/30 bg-port-accent/5' },
    verify: { label: 'Verify', desc: 'Verify the implementation', style: 'border-purple-600/30 bg-purple-600/5' },
  };
  const cfg = actionLabels[action.nextAction] || actionLabels.plan;

  const handleTrigger = async () => {
    setTriggering(true);
    const result = await api.triggerGsdPhaseAction(appId, action.phaseId, action.nextAction).catch(() => null);
    setTriggering(false);
    if (result) {
      toast.success(`${action.nextAction} task created for ${action.phaseId}`);
    }
  };

  return (
    <div className={`border rounded-lg p-4 flex items-center justify-between ${cfg.style}`}>
      <div>
        <div className="flex items-center gap-2 mb-1">
          <ArrowRight size={14} className="text-gray-400" />
          <span className="text-sm font-medium text-white">Next: {cfg.label} phase {action.phaseId}</span>
        </div>
        <p className="text-xs text-gray-500">{cfg.desc}</p>
      </div>
      <button
        onClick={handleTrigger}
        disabled={triggering}
        className="px-4 py-2 bg-port-accent/20 text-port-accent hover:bg-port-accent/30 rounded-lg text-sm flex items-center gap-2 border border-port-accent/30 disabled:opacity-50"
      >
        <Play size={14} /> {triggering ? 'Creating...' : `${cfg.label} Phase`}
      </button>
    </div>
  );
}

export default function GsdTab({ appId, repoPath }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const [project, setProject] = useState(null);
  const [pendingActions, setPendingActions] = useState([]);
  const [gsdStatus, setGsdStatus] = useState(null);
  const [loading, setLoading] = useState(true);

  const expandedPhase = searchParams.get('phase') || null;
  const selectedDoc = searchParams.get('doc') || null;

  const setExpandedPhase = (phaseId) => {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev);
      if (phaseId && phaseId !== expandedPhase) {
        next.set('phase', phaseId);
      } else {
        next.delete('phase');
      }
      return next;
    }, { replace: true });
  };

  const setSelectedDoc = (docName) => {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev);
      if (docName) {
        next.set('doc', docName);
      } else {
        next.delete('doc');
      }
      return next;
    }, { replace: true });
  };

  const fetchData = async () => {
    setLoading(true);

    // Fetch GSD status from documents endpoint (silent, no toast)
    const docsResp = await fetch(`/api/apps/${appId}/documents`).catch(() => null);
    const docsData = docsResp?.ok ? await docsResp.json().catch(() => null) : null;
    const gsd = docsData?.gsd || {};
    setGsdStatus(gsd);

    // Only fetch project data if we have a roadmap + state (full project)
    if (gsd.hasRoadmap && gsd.hasState) {
      const [projectResp, phasesResp] = await Promise.all([
        fetch(`/api/cos/gsd/projects/${appId}`).catch(() => null),
        fetch(`/api/cos/gsd/projects/${appId}/phases`).catch(() => null),
      ]);
      if (projectResp?.ok) {
        const data = await projectResp.json().catch(() => null);
        setProject(data);
      }
      if (phasesResp?.ok) {
        const data = await phasesResp.json().catch(() => null);
        setPendingActions(data?.pendingActions || []);
      }
    } else {
      setProject(null);
      setPendingActions([]);
    }

    setLoading(false);
  };

  useEffect(() => {
    fetchData();
  }, [appId]);

  if (loading) {
    return <BrailleSpinner text="Loading GSD project" />;
  }

  // Show setup guide if project isn't fully initialized
  if (!project) {
    return <GsdSetupGuide gsd={gsdStatus || {}} appId={appId} repoPath={repoPath} onRefresh={fetchData} />;
  }

  return (
    <div className="max-w-5xl space-y-6">
      {/* Project Header */}
      <GsdProjectHeader
        project={project}
        pendingActions={pendingActions}
        appId={appId}
        repoPath={repoPath}
        onRefresh={fetchData}
      />

      {/* Next Action Banner */}
      <NextActionBanner pendingActions={pendingActions} appId={appId} />

      {/* Phase Cards */}
      <PhaseCardList
        phases={project?.phases || []}
        pendingActions={pendingActions}
        appId={appId}
        expandedPhase={expandedPhase}
        onTogglePhase={setExpandedPhase}
      />

      {/* Concerns */}
      {project?.concerns && (
        <div className="bg-port-card border border-port-border rounded-lg p-4">
          <GsdConcernsPanel
            appId={appId}
            concerns={project.concerns}
            onTaskCreated={fetchData}
          />
        </div>
      )}

      {/* Documents Panel */}
      <GsdDocumentsPanel
        appId={appId}
        selectedDoc={selectedDoc}
        onSelectDoc={setSelectedDoc}
      />
    </div>
  );
}
