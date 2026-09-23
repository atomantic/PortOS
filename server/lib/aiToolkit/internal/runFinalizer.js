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
  outputPath,
  metadataPath,
  getOutput,
  getReasoning,
  providerStatusService,
  hooks,
  onComplete,
  handleProviderError,
  safeJsonParse,
  safeSettle,
  consumeActiveStop,
}) {
  const readMetadata = async () => metadataObject(
    safeJsonParse(await readFile(metadataPath, 'utf-8').catch(() => '{}'))
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
    if (state.partialOutput) await atomicWrite(outputPath, state.partialOutput).catch(() => {});
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
        await providerStatusService.markApiSuccess(provider.id).catch(err => {
          console.error(`❌ Failed to clear provider rate-limit state: ${err.message}`);
        });
      }

      safeSettle(() => hooks.onRunCompleted?.(metadata, output), `Run ${runId} onRunCompleted hook`);
      safeSettle(() => onComplete?.(metadata), `Run ${runId} onComplete`);
    } catch (writeErr) {
      console.error(`❌ Run ${runId} success finalize error: ${writeErr.message}`);
      const failMetadata = await readMetadata();
      failMetadata.endTime = new Date().toISOString();
      failMetadata.duration = Date.now() - startTime;
      failMetadata.success = false;
      failMetadata.error = `Run finalization failed: ${writeErr.message}`;
      failMetadata.errorCategory = ERROR_CATEGORIES.UNKNOWN;
      failMetadata.outputSize = Buffer.byteLength(getOutput());
      await atomicWrite(metadataPath, failMetadata).catch(() => {});
      safeSettle(() => hooks.onRunFailed?.(failMetadata, failMetadata.error, getOutput()), `Run ${runId} onRunFailed hook`);
      safeSettle(() => onComplete?.(failMetadata), `Run ${runId} onComplete`);
    }
  };

  const finalizeTimeout = async (bound) => {
    consumeActiveStop(runId);
    const error = bound === 'absolute'
      ? `API execution timed out after ${absoluteTimeout}ms: absolute runtime cap reached`
      : `API execution timed out after ${stallTimeout}ms with no stream progress`;
    try {
      const { metadata, partialOutput } = await openTerminalMetadata();
      metadata.error = error;
      metadata.errorCategory = ERROR_CATEGORIES.TIMEOUT;
      metadata.timeoutBound = bound;
      metadata.errorAnalysis = analyzeError(error);
      await atomicWrite(metadataPath, metadata);
      safeSettle(() => hooks.onRunFailed?.(metadata, error, partialOutput), `Run ${runId} onRunFailed hook`);
      safeSettle(() => onComplete?.(metadata), `Run ${runId} onComplete`);
    } catch (finalErr) {
      console.error(`❌ API run ${runId} timeout finalize error: ${finalErr.message}`);
      const salvaged = terminalState().partialOutput;
      safeSettle(() => onComplete?.({
        success: false,
        error,
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
      console.error(`❌ API run ${runId} cancel finalize error: ${err.message}`);
    });
    safeSettle(() => hooks.onRunCanceled?.({ runId }), `Run ${runId} onRunCanceled hook`);
    safeSettle(() => onComplete?.(metadata), `Run ${runId} onComplete`);
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
      await handleProviderError(provider.id, errorAnalysis, body);
    }

    await atomicWrite(metadataPath, metadata);
    safeSettle(() => hooks.onRunFailed?.(metadata, metadata.error, ''), `Run ${runId} onRunFailed hook`);
    safeSettle(() => onComplete?.(metadata), `Run ${runId} onComplete`);
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
      await handleProviderError(provider.id, errorAnalysis, partialOutput);
    }

    await atomicWrite(metadataPath, metadata);
    safeSettle(() => hooks.onRunFailed?.(metadata, metadata.error, partialOutput), `Run ${runId} onRunFailed hook`);
    safeSettle(() => onComplete?.(metadata), `Run ${runId} onComplete`);
  };

  const finalizeHandlerError = async (handlerErr) => {
    const failMetadata = {
      endTime: new Date().toISOString(),
      duration: Date.now() - startTime,
      success: false,
      error: `Run finalization failed: ${handlerErr.message}`,
      outputSize: Buffer.byteLength(getOutput()),
    };
    await atomicWrite(metadataPath, failMetadata).catch(() => {});
    safeSettle(() => hooks.onRunFailed?.(failMetadata, failMetadata.error, getOutput()), `Run ${runId} onRunFailed hook`);
    safeSettle(() => onComplete?.(failMetadata), `Run ${runId} onComplete`);
  };

  const finalize = async (cause) => {
    if (!lifecycle.markSettled()) return false;
    activeRuns.delete(runId);
    try {
      if (cause.type === 'success') await finalizeSuccess(cause);
      else if (cause.type === 'timeout') await finalizeTimeout(cause.bound);
      else if (cause.type === 'response-error') {
        if (consumeActiveStop(runId)) await finalizeCanceled();
        else await finalizeHttpError(cause);
      }
      else if (cause.type === 'stream-error') {
        if (consumeActiveStop(runId)) await finalizeCanceled();
        else await finalizeStreamError(cause.error);
      }
      else if (cause.type === 'canceled') await finalizeCanceled();
      return true;
    } catch (handlerErr) {
      console.error(`❌ Run ${runId} failure handler error: ${handlerErr.message}`);
      await finalizeHandlerError(handlerErr);
      return true;
    }
  };

  return { finalize };
}
