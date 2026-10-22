const RENDER_FAILURE_CONTEXT_LIMIT = 2000;

export function buildCreativeDirectorRenderFailureTask({ projectId, sceneId = null, jobId, error }) {
  const safeError = String(error || 'render failed').slice(0, RENDER_FAILURE_CONTEXT_LIMIT);
  const target = sceneId ? `scene ${sceneId}` : 'project-level render';
  return {
    description: `Creative Director render failure: fix project ${projectId} ${target}`,
    context: [
      'An automatic Creative Director media render failure needs investigation and a code fix.',
      `Project: ${projectId}`,
      `Scene: ${sceneId || 'none (project-level render)'}`,
      `Media job: ${jobId || 'unknown'}`,
      `Renderer error: ${safeError}`,
      '',
      'Inspect the render-parameter and provider-constraint path that produced this error. Implement the smallest durable fix, add or update focused tests, run the relevant server tests, and open a PR with the fix.',
    ].join('\n'),
    priority: 'HIGH',
    useWorktree: true,
    openPR: true,
    simplify: true,
    isRecovery: true,
    diagnostics: {
      triggerEvent: 'CREATIVE_DIRECTOR_RENDER_FAILED',
      target: 'creativeDirector/renderFailureHook',
      errorType: 'render-error',
      category: 'creative-director-render',
      tier: 'code-fix',
      fixStrategy: 'inspect-render-parameters-and-provider-constraints',
      failureReason: safeError,
    },
  };
}

export async function queueCreativeDirectorRenderFailureTask({ projectId, sceneId = null, jobId, error }) {
  const task = buildCreativeDirectorRenderFailureTask({ projectId, sceneId, jobId, error });
  const { addTask } = await import('../cosTaskStore.js');
  const queued = await addTask(task, 'internal');
  if (queued?.duplicate) {
    console.log(`⚠️ CD render repair already queued for ${projectId}/${sceneId || 'project'} as ${queued.id}`);
    return queued;
  }
  console.log(`🛠️ CD render repair task queued for ${projectId}/${sceneId || 'project'}: ${queued.id}`);
  return queued;
}
