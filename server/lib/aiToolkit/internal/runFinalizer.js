import { readFile } from 'fs/promises';
import { atomicWrite } from './atomicWrite.js';
import { analyzeError, analyzeHttpError, ERROR_CATEGORIES } from '../errorDetection.js';
import { describeTransportError } from './preHeaderRetry.js';

const metadataObject = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};

export function createRunFinalizer({
  runId,
  provider,
  startTime,
  activeRuns,
  lifecycle,
  stallTimeout,
  absoluteTimeout,
  callerRuntimeBudget = false,
  outputPath,
  metadataPath,
  getOutput,
  getReasoning,
  providerStatusService,
  hooks,
  onComplete,
  handleProviderError,
  safeJsonParse,
  consumeActiveStop,
  onPersistenceFailure,
  withAssetPublication = work => work(),
}) {
  const pendingHooks = [];
  const failed = () => onPersistenceFailure?.();
  // Invoke host callbacks only after releasing the recording lease. Hooks can
  // publish their own assets or wait for other admitted work.
  const terminalCallbacks = [];
  const settleTerminal = (fn, label) => terminalCallbacks.push({ fn, label });
  const runTerminal = (fn, label) => {
    try {
      const result = fn();
      if (result?.then) pendingHooks.push(Promise.resolve(result).catch(err => {
        failed(); console.error(`❌ ${label} failed: ${err.message}`);
      }));
    } catch (err) { failed(); console.error(`❌ ${label} failed: ${err.message}`); }
  };
  const readMetadata = async () => metadataObject(
    safeJsonParse(await readFile(metadataPath, 'utf-8').catch(() => { failed(); return '{}'; }))
  );

  const terminalState = () => {
    const output = getOutput();
    const reasoning = getReasoning();
    const usedReasoningAsFallback = !output.trim() && reasoning.trim().length > 0;
    return {
      partialOutput: usedReasoningAsFallback ? reasoning : output,
      hadReasoning: reasoning.length > 0,
      usedReasoningAsFallback,
    };
  };

  const openTerminalMetadata = async () => {
    const state = terminalState();
    await atomicWrite(outputPath, state.partialOutput);
    const metadata = await readMetadata();
    metadata.endTime = new Date().toISOString();
    metadata.duration = Date.now() - startTime;
    metadata.success = false;
    metadata.outputSize = Buffer.byteLength(state.partialOutput);
    metadata.hadReasoning = state.hadReasoning;
    metadata.usedReasoningAsFallback = state.usedReasoningAsFallback;
    return { metadata, partialOutput: state.partialOutput };
  };

  const finalizeSuccess = async ({ finishReason, usedReasoningAsFallback }) => {
    consumeActiveStop(runId);
    try {
      const output = getOutput();
      await atomicWrite(outputPath, output);
      const metadata = await readMetadata();
      metadata.endTime = new Date().toISOString();
      metadata.duration = Date.now() - startTime;
      metadata.exitCode = 0;
      metadata.success = true;
      metadata.outputSize = Buffer.byteLength(output);
      metadata.hadReasoning = getReasoning().length > 0;
      metadata.usedReasoningAsFallback = usedReasoningAsFallback;
      if (finishReason) metadata.finishReason = finishReason;
      await atomicWrite(metadataPath, metadata);

      if (typeof providerStatusService?.markApiSuccess === 'function') {
        settleTerminal(() => providerStatusService.markApiSuccess(provider.id).catch(err => {
          console.error(`❌ Failed to clear provider rate-limit state: ${err.message}`);
        }), `Run ${runId} provider success hook`);
      }

      settleTerminal(() => hooks.onRunCompleted?.(metadata, output), `Run ${runId} onRunCompleted hook`);
      settleTerminal(() => onComplete?.(metadata), `Run ${runId} onComplete`);
    } catch (writeErr) {
      failed();
      console.error(`❌ Run ${runId} success finalize error: ${writeErr.message}`);
      const failMetadata = await readMetadata();
      failMetadata.endTime = new Date().toISOString();
      failMetadata.duration = Date.now() - startTime;
      failMetadata.success = false;
      failMetadata.error = `Run finalization failed: ${writeErr.message}`;
      failMetadata.errorCategory = ERROR_CATEGORIES.UNKNOWN;
      failMetadata.outputSize = (await readFile(outputPath).catch(() => '')).length;
      await atomicWrite(metadataPath, failMetadata).catch(failed);
      settleTerminal(() => hooks.onRunFailed?.(failMetadata, failMetadata.error, getOutput()), `Run ${runId} onRunFailed hook`);
      settleTerminal(() => onComplete?.(failMetadata), `Run ${runId} onComplete`);
    }
  };

  const finalizeTimeout = async (bound) => {
    consumeActiveStop(runId);
    const budgetExhausted = bound === 'absolute' && callerRuntimeBudget;
    const error = budgetExhausted
      ? `Caller runtime budget exhausted after ${absoluteTimeout}ms; adjust the policy and explicitly resume`
      : bound === 'absolute'
      ? `API execution timed out after ${absoluteTimeout}ms: absolute runtime cap reached`
      : `API execution timed out after ${stallTimeout}ms with no stream progress`;
    const terminal = {
      error,
      timeoutBound: bound,
      errorCategory: budgetExhausted ? ERROR_CATEGORIES.RUNTIME_BUDGET_EXHAUSTED : ERROR_CATEGORIES.TIMEOUT,
      errorAnalysis: budgetExhausted
        ? { hasError: true, category: ERROR_CATEGORIES.RUNTIME_BUDGET_EXHAUSTED, message: error }
        : analyzeError(error),
      ...(budgetExhausted ? { timeoutOrigin: 'caller-budget', runtimeBudgetMs: absoluteTimeout } : {}),
    };
    try {
      const { metadata, partialOutput } = await openTerminalMetadata();
      Object.assign(metadata, terminal);
      await atomicWrite(metadataPath, metadata);
      settleTerminal(() => hooks.onRunFailed?.(metadata, error, partialOutput), `Run ${runId} onRunFailed hook`);
      settleTerminal(() => onComplete?.(metadata), `Run ${runId} onComplete`);
    } catch (finalErr) {
      failed();
      console.error(`❌ API run ${runId} timeout finalize error: ${finalErr.message}`);
      const salvaged = terminalState().partialOutput;
      settleTerminal(() => onComplete?.({
        success: false,
        ...terminal,
        endTime: new Date().toISOString(),
        duration: Date.now() - startTime,
        outputSize: Buffer.byteLength(salvaged),
      }), `Run ${runId} onComplete`);
    }
  };

  const finalizeCanceled = async () => {
    const { metadata } = await openTerminalMetadata();
    metadata.canceled = true;
    metadata.completionReason = 'canceled';
    metadata.error = 'API run canceled';
    metadata.errorCategory = ERROR_CATEGORIES.CANCELED;
    await atomicWrite(metadataPath, metadata).catch(err => {
      failed();
      console.error(`❌ API run ${runId} cancel finalize error: ${err.message}`);
    });
    settleTerminal(() => hooks.onRunCanceled?.({ runId }), `Run ${runId} onRunCanceled hook`);
    settleTerminal(() => onComplete?.(metadata), `Run ${runId} onComplete`);
  };

  const finalizeHttpError = async ({ status, statusText, body, headers }) => {
    const metadata = await readMetadata();
    metadata.endTime = new Date().toISOString();
    metadata.duration = Date.now() - startTime;
    metadata.success = false;
    const errorAnalysis = analyzeHttpError({ status: status || 0, statusText: statusText || '', body, headers });
    metadata.error = errorAnalysis.message || `API error: ${status}`;
    metadata.errorCategory = errorAnalysis.category;
    metadata.errorAnalysis = errorAnalysis;

    if (errorAnalysis.hasError &&
        (errorAnalysis.category === ERROR_CATEGORIES.RATE_LIMIT ||
         errorAnalysis.category === ERROR_CATEGORIES.USAGE_LIMIT)) {
      settleTerminal(() => handleProviderError(provider.id, errorAnalysis, body), `Run ${runId} provider error hook`);
    }

    await atomicWrite(metadataPath, metadata);
    settleTerminal(() => hooks.onRunFailed?.(metadata, metadata.error, ''), `Run ${runId} onRunFailed hook`);
    settleTerminal(() => onComplete?.(metadata), `Run ${runId} onComplete`);
  };

  const finalizeStreamError = async (error) => {
    const { metadata, partialOutput } = await openTerminalMetadata();
    const errorDescription = describeTransportError(error);
    const errorAnalysis = analyzeError(errorDescription);
    metadata.error = errorAnalysis.message || errorDescription;
    metadata.errorCategory = errorAnalysis.category;
    metadata.errorAnalysis = errorAnalysis;

    if (errorAnalysis.hasError &&
        (errorAnalysis.category === ERROR_CATEGORIES.RATE_LIMIT ||
         errorAnalysis.category === ERROR_CATEGORIES.USAGE_LIMIT)) {
      settleTerminal(() => handleProviderError(provider.id, errorAnalysis, partialOutput), `Run ${runId} provider error hook`);
    }

    await atomicWrite(metadataPath, metadata);
    settleTerminal(() => hooks.onRunFailed?.(metadata, metadata.error, partialOutput), `Run ${runId} onRunFailed hook`);
    settleTerminal(() => onComplete?.(metadata), `Run ${runId} onComplete`);
  };

  const finalizeHandlerError = async (handlerErr) => {
    const failMetadata = {
      ...await readMetadata(),
      endTime: new Date().toISOString(),
      duration: Date.now() - startTime,
      success: false,
      error: `Run finalization failed: ${handlerErr.message}`,
      outputSize: (await readFile(outputPath).catch(() => '')).length,
    };
    await atomicWrite(metadataPath, failMetadata).catch(failed);
    settleTerminal(() => hooks.onRunFailed?.(failMetadata, failMetadata.error, getOutput()), `Run ${runId} onRunFailed hook`);
    settleTerminal(() => onComplete?.(failMetadata), `Run ${runId} onComplete`);
  };

  const finalizeOnce = async (cause) => {
    if (!lifecycle.markSettled()) return false;
    activeRuns.delete(runId);
    try {
      await withAssetPublication(async () => {
        try {
          if (cause.type === 'success') await finalizeSuccess(cause);
          else if (cause.type === 'timeout') await finalizeTimeout(cause.bound);
          else if (cause.type === 'response-error') {
            if (consumeActiveStop(runId)) await finalizeCanceled();
            else await finalizeHttpError(cause);
          } else if (cause.type === 'stream-error') {
            if (consumeActiveStop(runId)) await finalizeCanceled();
            else await finalizeStreamError(cause.error);
          } else if (cause.type === 'canceled') await finalizeCanceled();
        } catch (handlerErr) {
          failed();
          console.error(`❌ Run ${runId} failure handler error: ${handlerErr.message}`);
          await finalizeHandlerError(handlerErr);
        }
      });
      return true;
    } finally {
      for (const { fn, label } of terminalCallbacks) runTerminal(fn, label);
      await Promise.all(pendingHooks);
    }
  };

  let pending;
  const finalize = cause => {
    if (pending) return Promise.resolve(false);
    pending = finalizeOnce(cause);
    return pending;
  };
  return { finalize, settled: () => pending || Promise.resolve() };
}
