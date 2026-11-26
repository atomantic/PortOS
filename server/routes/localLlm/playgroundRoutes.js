import { Router } from 'express'
import { asyncHandler } from '../../lib/errorHandler.js'
import { validateRequest } from '../../lib/validateRequest.js'
import { localLlmTestSchema, localLlmCompareSchema } from '../../lib/mediaValidation.js'
import { listEndpointRuntimeModels } from '../../services/localRuntimeEndpoints.js'
import { runLocalLlmTest, compareLocalLlmModels } from '../../services/localLlmPlayground.js'
import { abortSignalFromResponse } from '../../lib/requestAbort.js'
import { awaitWritableDrain } from '../../lib/streamBackpressure.js'

const router = Router()

// POST /api/local-llm/test/stream — run one installed local model with a prompt and
// stream the model's output token-by-token as newline-delimited JSON (NDJSON) so the playground
// can render live. Frames: `{ type: 'token', delta, kind }` per chunk (kind is
// 'content' or 'reasoning' so the client can render thinking separately), then a
// terminal `{ type: 'result', result }` carrying the run object
// (text, speed metrics, runId, and any error). `runLocalLlmTest` resolves rather than
// throws — including on timeout/abort — so the result frame always lands while
// the socket is alive, and no JSON error body is attempted after headers flush.
router.post('/test/stream', asyncHandler(async (req, res) => {
  const body = validateRequest(localLlmTestSchema, req.body)
  res.set({
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  res.flushHeaders?.()

  // Once headers are flushed the response is "in stream mode" — never throw past
  // here. A write after the client disconnected can throw ERR_STREAM_WRITE_AFTER_END;
  // treat any failure as a dead socket and drop the frame.
  //
  // Honour socket backpressure: when `res.write` returns false the kernel/send
  // buffer is full, so await the next `drain` before letting the producer queue
  // more NDJSON. A fast local model writing to a slow reader would otherwise
  // buffer the whole response in memory. The producer awaits `onToken`, so
  // returning this promise actually pauses the upstream read until the socket
  // catches up. (`awaitWritableDrain` is the same helper routes/ask.js uses.)
  const write = async (frame) => {
    if (res.writableEnded || res.destroyed) return
    let writeOk
    try { writeOk = res.write(`${JSON.stringify(frame)}\n`) } catch { return /* client gone */ }
    if (!writeOk) await awaitWritableDrain(res)
  }

  // `runLocalLlmTest` resolves for in-stream failures, but can still THROW before
  // the stream opens (unconfigured/invalid provider). Headers are already flushed,
  // so a throw past here can't bubble to asyncHandler's JSON error path without
  // ERR_HTTP_HEADERS_SENT — convert it to a terminal result frame the client toasts.
  const result = await runLocalLlmTest({
    ...body,
    signal: abortSignalFromResponse(res),
    onToken: (delta, kind = 'content') => (delta ? write({ type: 'token', delta, kind }) : undefined),
  }).catch((err) => ({
    backend: body.backend,
    modelId: body.modelId,
    error: err?.message || 'Local LLM test failed',
    text: '',
  }))
  await write({ type: 'result', result })
  res.end()
}))

// POST /api/local-llm/compare — run one prompt through multiple local models.
// `round-robin` measures each model in isolation; `parallel` intentionally
// measures contention when several loaded local models run at once.
router.post('/compare', asyncHandler(async (req, res) => {
  const body = validateRequest(localLlmCompareSchema, req.body)
  res.json(await compareLocalLlmModels({ ...body, signal: abortSignalFromResponse(res) }))
}))

// GET /api/local-llm/runtime-models — the models each bare-endpoint runtime (llama.cpp, MTPLX,
// Splash, ...) serves, for the Playground picker. Lists only; never generates, so it is safe on page load.
router.get('/runtime-models', asyncHandler(async (_req, res) => {
  res.json({ runtimes: await listEndpointRuntimeModels() })
}))

export default router
