/** Execute API runs and stream provider responses through terminal settlement. */
import { evaluateSecretEndpoint } from '../endpointGuard.js';
import { existsSync } from 'fs';
import { join, extname, basename, isAbsolute } from 'path';
import { apiGenerationOptions, openRouterBodyFragment } from './generationOptions.js';
import { buildOllamaNativeChatBody, ollamaNativeChatUrl, ollamaNativeFrameToChunk } from './ollamaNativeChat.js';
import { isOllamaBackedProvider, ollamaThinkLevel, withModelNumCtx } from './ollamaBacked.js';
import { describeTransportError, fetchWithPreHeaderRetry, isReplaySafeLocalRequest, sendWithCredentialSession } from './preHeaderRetry.js';
import { DEFAULT_API_RUN_TIMEOUT_MS, apiRunAbsoluteTimeoutMs } from './runTimeouts.js';
import { requestProviderStream } from './streamTransport.js';
import { createRunLifecycle } from './runLifecycle.js';
import { createRunFinalizer } from './runFinalizer.js';
import { readFile } from 'fs/promises';
import { runOwnership } from './runOwnership.js';
import { safeJsonParse } from './runStore.js';
import { safeSettle } from './runCallbacks.js';

export function createApiStreamExecutor({
  runsPath, screenshotsDir, patchRunMetadata, activeRuns, activeStopRequests,
  hooks, providerStatusService, handleProviderError, withAssetPublication, consumeActiveStop,
}) {
  function getMimeType(filepath) {
    const ext = extname(filepath).toLowerCase();
    const mimeTypes = {
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.webp': 'image/webp'
    };
    return mimeTypes[ext] || 'image/png';
  }

  async function loadImageAsBase64(imagePath) {
    if (typeof imagePath !== 'string' || !imagePath) {
      throw new Error(`Invalid screenshot path: ${imagePath}`);
    }
    // Relative references are anchored under screenshotsDir with `basename`
    // applied, so a `../`-traversal collapses to a bare filename and can't
    // escape the screenshots dir. Absolute paths come only from trusted
    // in-process callers (e.g. PortOS's Universe Builder, whose
    // `resolveImageSources` has already validated them against an approved
    // image root) and pass through unchanged. The untrusted POST /api/runs
    // surface is additionally sanitized at the route boundary
    // (sanitizeScreenshotRefs in routes/runs.js) so an attacker-supplied
    // absolute path never reaches this loader. See issue #1870 / #1820.
    const fullPath = isAbsolute(imagePath)
      ? imagePath
      : join(screenshotsDir, basename(imagePath));

    if (!existsSync(fullPath)) {
      throw new Error(`Image not found: ${fullPath}`);
    }

    const buffer = await readFile(fullPath);
    const mimeType = getMimeType(fullPath);
    return `data:${mimeType};base64,${buffer.toString('base64')}`;
  }

  return async function executeApiRun({ runId, provider, model, prompt, workspacePath, screenshots, onData, onComplete, timeout, absoluteTimeoutMs, maxTokens, beforeExecute, onSettled, onPersistenceFailure, effort = provider?.effort ?? null }) {
    const ownershipSaved = patchRunMetadata(runId, runOwnership('api'));
    const runDir = join(runsPath, runId);
    const outputPath = join(runDir, 'output.txt');
    const metadataPath = join(runDir, 'metadata.json');

    const startTime = Date.now();
    let output = '';
    let reasoning = '';

    const headers = {
      'Content-Type': 'application/json'
    };
    if (provider.apiKey) {
      headers['Authorization'] = `Bearer ${provider.apiKey}`;
    }

    const controller = new AbortController();
    activeStopRequests.delete(runId);
    activeRuns.set(runId, controller);
    await ownershipSaved;

    // Only the streaming API runner interprets provider.timeout as a stall
    // bound. Other provider and CLI callers can use it as a wall clock.
    const stallTimeout = timeout ?? provider.timeout ?? DEFAULT_API_RUN_TIMEOUT_MS;
    const absoluteTimeout = apiRunAbsoluteTimeoutMs(stallTimeout, absoluteTimeoutMs);
    let finalizer;
    const lifecycle = createRunLifecycle({
      runId,
      controller,
      stallTimeout,
      absoluteTimeout,
      onTimeout: bound => finalizer.finalize({ type: 'timeout', bound }),
    });
    const recording = hooks.trackRunOutput?.(outputPath, prompt);
    finalizer = createRunFinalizer({
      withAssetPublication,
      recording,
      runId,
      provider,
      startTime,
      activeRuns,
      lifecycle,
      stallTimeout,
      absoluteTimeout,
      callerRuntimeBudget: absoluteTimeout < apiRunAbsoluteTimeoutMs(stallTimeout),
      outputPath,
      metadataPath,
      getOutput: () => recording ? recording.redact(output) : output,
      getReasoning: () => recording ? recording.redact(reasoning) : reasoning,
      providerStatusService,
      hooks,
      onComplete,
      onPersistenceFailure,
      handleProviderError,
      safeJsonParse,
      safeSettle,
      consumeActiveStop,
    });
    lifecycle.start();

    hooks.onRunStarted?.({ runId, provider: provider.name, model });

    let messageContent;
    if (screenshots && screenshots.length > 0) {
      console.log(`📸 Loading ${screenshots.length} screenshots for vision API`);
      const contentParts = [];

      for (const screenshotPath of screenshots) {
        const imageDataUrl = await loadImageAsBase64(screenshotPath).catch(err => {
          console.error(`❌ Failed to load screenshot ${screenshotPath}: ${err.message}`);
          return null;
        });
        if (imageDataUrl) {
          contentParts.push({
            type: 'image_url',
            image_url: { url: imageDataUrl }
          });
        }
      }

      contentParts.push({ type: 'text', text: prompt });
      messageContent = contentParts;
    } else {
      messageContent = prompt;
    }

    // Never send the API key to an arbitrary/metadata host (SSRF / key
    // exfiltration). Keyless local-LLM runs are unaffected.
    const endpointGuard = provider.apiKey
      ? evaluateSecretEndpoint(provider.endpoint, { allowCustomEndpoint: provider.allowCustomEndpoint === true })
      : { allowed: true, reason: null };

    const ensureProviderReady = hooks.ensureProviderReady || (async () => ({ success: true }));
    const ready = endpointGuard.allowed
      ? await ensureProviderReady(provider).catch((err) => ({ success: false, error: err.message }))
      : { success: false, error: `Endpoint blocked: ${endpointGuard.reason}` };
    if (controller.signal.aborted) {
      await finalizer.finalize({ type: 'canceled' });
      await finalizer.settled();
      onSettled?.();
      return runId;
    }
    if (ready.success && beforeExecute) {
      try { await beforeExecute(); }
      catch {
        await finalizer.finalize({ type: 'canceled' });
        await finalizer.settled();
        onSettled?.();
        return runId;
      }
    }
    // An Ollama provider with a `numCtx` goes to the native `/api/chat`:
    // `/v1/chat/completions` cannot carry a context window (it ignores
    // `num_ctx` in any position), so the model would load at the daemon
    // default and silently drop the prompt's head. See
    // ./ollamaNativeChat.js.
    const requestModel = model || provider.defaultModel;
    // A per-model window (`modelNumCtx`) replaces `numCtx` for this model only.
    const windowProvider = withModelNumCtx(provider, requestModel);
    const nativeOllamaUrl = ollamaNativeChatUrl(windowProvider);
    // An effort the model takes as an Ollama thinking level replaces the
    // provider's boolean `thinking` for this run.
    const thinkLevel = isOllamaBackedProvider(provider) || provider?.mtplxBacked === true ? ollamaThinkLevel(requestModel, effort) : null;
    // MTPLX has no native `think` field: Inkling takes its level as a chat-template kwarg.
    const mtplxEffort = provider?.mtplxBacked === true && thinkLevel;
    const generation = { ...apiGenerationOptions(provider), ...(thinkLevel && !mtplxEffort ? { think: thinkLevel } : {}) };
    const requestBody = nativeOllamaUrl
      ? buildOllamaNativeChatBody({ model: requestModel, messageContent, provider: windowProvider, generation, maxTokens })
      : {
          model: requestModel,
          messages: [{ role: 'user', content: messageContent }],
          stream: true,
          ...apiGenerationOptions(provider),
          ...openRouterBodyFragment(provider, requestModel),
          ...(mtplxEffort ? { chat_template_kwargs: { ...apiGenerationOptions(provider).chat_template_kwargs, reasoning_effort: thinkLevel } } : {}),
          ...(thinkLevel ? { reasoning_effort: thinkLevel } : {}),
          ...(Number.isInteger(maxTokens) && maxTokens > 0 ? { max_tokens: maxTokens } : {}),
        };
    // A host credential pool (#17384) may rotate this request onto another key
    // of the same service after a 429/402/401, before the provider-wide bench
    // and fallback chain see the failure. `null` = send the record's own key.
    const credentialSession = endpointGuard.allowed && ready.success && provider.apiKey && hooks.openCredentialSession
      ? await Promise.resolve(hooks.openCredentialSession(provider, requestModel)).catch((err) => {
        console.log(`🔑 Run ${runId} credential pool unavailable: ${err.message}`);
        return null;
      })
      : null;
    const sendOnce = (apiKey) => fetchWithPreHeaderRetry(() => requestProviderStream(nativeOllamaUrl || `${provider.endpoint}/chat/completions`, {
          headers: apiKey ? { ...headers, Authorization: `Bearer ${apiKey}` } : headers,
          signal: controller.signal,
          body: JSON.stringify(requestBody)
        }), {
          signal: controller.signal,
          // A caller-owned budget/admission hook accounts for one invocation;
          // do not silently replay a possibly processed local generation.
          allowReplay: !beforeExecute && isReplaySafeLocalRequest(provider),
        }).catch(err => ({ ok: false, error: describeTransportError(err), status: 0 }));
    const response = !endpointGuard.allowed
      ? { ok: false, error: `Endpoint blocked: ${endpointGuard.reason}`, status: 0 }
      : ready.success
      ? await sendWithCredentialSession(credentialSession, provider.apiKey, sendOnce, controller.signal)
      : { ok: false, error: ready.error || 'Provider readiness check failed', status: 0 };

    if (!response.ok) {
      let responseBody = response.error || '';
      if (response.text) {
        responseBody = await response.text().catch(() => response.error || '');
      }
      await finalizer.finalize({
        type: 'response-error',
        status: response.status,
        statusText: response.statusText,
        body: responseBody,
        headers: response.headers,
      });
      await finalizer.settled();
      onSettled?.();
      return runId;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    // A read returns an arbitrary SLICE of bytes, never a whole SSE frame, so
    // both boundaries have to be carried across iterations:
    //  - `buffer` holds the partial trailing LINE. Parsing per-chunk instead
    //    fed JSON.parse a frame cut in half at the ~8KB read boundary, which
    //    threw `Unterminated string in JSON at position 8064` and failed a
    //    220s NVIDIA NIM nemotron run with outputSize 0 — a reasoning model's
    //    hidden-channel frames are big enough to straddle a read routinely.
    //  - `{ stream: true }` holds the partial trailing CHARACTER, so a
    //    multi-byte rune split across reads doesn't decode to U+FFFD.
    // This mirrors every other SSE consumer in the tree (openAiChatStream.js,
    // ollamaManager.js, voice/llm.js); this loop was the lone holdout.
    let buffer = '';
    let finishReason = null;

    const consumeLine = (rawLine) => {
      // A CRLF transport leaves `\r` on each line: it has to come off before
      // the terminal-sentinel comparison, or `[DONE]\r` falls through to
      // JSON.parse and throws at the very end of an otherwise-good stream.
      const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
      // The native Ollama stream is NDJSON — one bare JSON object per line,
      // no `data: ` framing — reshaped into the OpenAI chunk read below.
      if (nativeOllamaUrl) {
        if (!line.trim()) return;
        const frame = safeJsonParse(line, null);
        if (!frame) {
          console.error(`❌ Run ${runId} skipped an unparseable stream frame (${line.length} chars)`);
          return;
        }
        consumeChunk(ollamaNativeFrameToChunk(frame));
        return;
      }
      if (!line.startsWith('data: ')) return;

      const data = line.slice(6);
      // `data: ` with an empty payload is a heartbeat on some providers, not a
      // frame — it must not reach the parse-failure log below, which would
      // otherwise emit a line per keep-alive for the life of the stream.
      if (!data.trim() || data === '✅' || data === '[DONE]') return;

      // One malformed frame must not discard the tokens around it. Before the
      // buffering above, every truncated frame reached here and its throw
      // aborted the whole run; now a parse failure can only mean the provider
      // actually emitted a bad frame, which is worth a log line, not the run.
      const parsed = safeJsonParse(data, null);
      if (!parsed) {
        console.error(`❌ Run ${runId} skipped an unparseable stream frame (${data.length} chars)`);
        return;
      }
      consumeChunk(parsed);
    };

    // One OpenAI-shaped chunk — an SSE `data:` frame, or a native Ollama
    // frame already reshaped by ollamaNativeFrameToChunk.
    const consumeChunk = (parsed) => {
      const choice = parsed?.choices?.[0];
      if (typeof choice?.finish_reason === 'string') finishReason = choice.finish_reason;
      const delta = choice?.delta;

      if (delta?.content) {
        const text = delta.content;
        output += text;
        onData?.({ text });
      }

      // The hidden channel goes by three names: OpenRouter-style endpoints
      // use `reasoning`, NVIDIA NIM / vLLM / DeepSeek-R1-compatible servers
      // use `reasoning_content`, and llama.cpp/MTPLX sometimes say
      // `thinking`. First one present wins — a provider sends one spelling,
      // and the precedence matches ../openAiChatStream.js so a frame that
      // somehow carried two would resolve identically on both readers.
      // Reading only `reasoning` silently discarded EVERY reasoning token
      // from NIM — `nvidia/nemotron-3.5-lightning-30b-a3b` sends 126 of 128
      // frames as `reasoning_content` — so the fallback below never fired and
      // a cut-off run reported `outputSize: 0`, indistinguishable from a
      // provider that answered nothing at all. Restated rather than imported
      // because this directory stays self-contained — see ../AGENTS.md.
      const reasoningDelta = delta?.reasoning || delta?.reasoning_content || delta?.thinking;
      if (reasoningDelta) {
        reasoning += reasoningDelta;
      }
    };

    const processStream = async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        // Bytes arrived, so the upstream is alive: push the no-progress bound
        // out. An EMPTY chunk is deliberately not progress — it proves the
        // reader woke, not that the provider produced anything, and treating
        // it as a heartbeat would let a reader spinning on zero-length reads
        // hold the stall bound open indefinitely. The absolute cap is what
        // bounds a provider that DOES trickle real bytes forever.
        if (value?.byteLength > 0) lifecycle.noteStreamProgress();

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        // The last element is either an incomplete line or '' — either way it
        // is not ready to parse, so it becomes the next iteration's prefix.
        buffer = lines.pop() || '';

        for (const line of lines) consumeLine(line);
      }

      // A stream that ends without a trailing newline (or without [DONE])
      // still has a complete frame sitting in the carry buffer; dropping it
      // would silently truncate the tail of the answer.
      buffer += decoder.decode();
      if (buffer.trim()) consumeLine(buffer);

      // Capture the fallback decision BEFORE mutating `output` — otherwise
      // the metadata check below is always false on the reasoning-only path
      // because `output` was just overwritten with the reasoning text.
      const usedReasoningAsFallback = !output.trim() && reasoning.trim().length > 0;
      if (usedReasoningAsFallback) {
        console.log(`🧠 Reasoning model detected - using reasoning as output (${reasoning.length} chars)`);
        output = reasoning;
        onData?.({ text: reasoning, isReasoning: true });
      }

      await finalizer.finalize({
        type: 'success',
        finishReason,
        usedReasoningAsFallback,
      });
    };

    // The finalizer shares partial-output and reasoning salvage across
    // terminal paths, and classifies stream errors using nested causes.
    processStream().catch(async err => {
      await finalizer.finalize({ type: 'stream-error', error: err });
    }).finally(async () => {
      // A timeout can finish metadata before the aborted reader settles.
      // Resource ownership ends only after both transport and saving finish.
      try { await reader.cancel?.(); reader.releaseLock?.(); }
      catch (err) { onPersistenceFailure?.(); console.error(`❌ Run ${runId} reader cleanup failed: ${err.message}`); }
      await finalizer.settled();
      onSettled?.();
    }).catch(handlerErr => {
      onPersistenceFailure?.();
      console.error(`❌ Run ${runId} failure handler error: ${handlerErr.message}`);
    });

    return runId;
  };
}
