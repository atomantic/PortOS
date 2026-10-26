/** Queue installs its durable recorder without making direct video callers import the queue. */
let recorder = null;

export function setVideoExecutionRecorder(value) {
  recorder = value;
}

export const recordVideoExecution = (jobId, meta) => recorder
  ? recorder.recordExecution(jobId, meta) : Promise.resolve(false);

export const recordVideoExecutionDiagnostics = (jobId, diagnostics) => recorder
  ? recorder.recordDiagnostics(jobId, diagnostics) : Promise.resolve(false);
