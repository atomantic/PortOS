/** Queue installs its durable recorder without making direct video callers import the queue. */
let recorder = null;

export function setVideoExecutionRecorder(value) {
  recorder = value;
}

export const recordVideoExecution = (jobId, meta) => {
  if (recorder) return recorder.recordExecution(jobId, meta);
  if (meta?.executionParent != null) return Promise.reject(new Error('Queued video segment recorder is unavailable'));
  return Promise.resolve(false);
};

export const recordVideoExecutionDiagnostics = (jobId, diagnostics, executionParent) => recorder
  ? recorder.recordDiagnostics(jobId, diagnostics, ...(executionParent == null ? [] : [executionParent])) : Promise.resolve(false);
