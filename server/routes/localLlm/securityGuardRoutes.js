import { Router } from 'express'
import { asyncHandler, ServerError } from '../../lib/errorHandler.js'
import { ABUSE_GUARD_PAGE_BREADCRUMB } from '../../lib/navManifest.js'
import { validateRequest } from '../../lib/validateRequest.js'
import { manualGuardScanSchema } from '../../lib/mediaValidation.js'
import { localLlmProgress as emitter } from '../localLlmProgress.js'
import {
  getModelAbuseGuardStatus,
  installModelAbuseGuard,
  cancelModelAbuseGuardInstall,
  runModelAbuseScan,
} from '../../services/modelAbuseGuard.js'

const router = Router()

// The model-abuse guard has its own lifecycle: it is a pinned, offline
// classifier and must never be installed through the general chat-model path.
// `ready` covers only the Prompt Guard classifier. GitHub contribution
// assessment also needs a provider and model, reported separately so a green
// guard cannot hide a coordinator that can never assess a pull request.
router.get('/security-guard/status', asyncHandler(async (_req, res) => {
  const { getContributionAssessmentReadiness } = await import('../../services/untrustedContent.js')
  const [status, contributionAssessment] = await Promise.all([
    getModelAbuseGuardStatus(),
    getContributionAssessmentReadiness(),
  ])
  res.json({ ...status, contributionAssessment })
}))

// Explicit operator action: the default host-control write gate applies. This
// runs only the local abuse scan, not a GitHub contribution assessment.
router.post('/security-guard/scan', asyncHandler(async (req, res) => {
  const { content } = validateRequest(manualGuardScanSchema, req.body ?? {})
  const result = await runModelAbuseScan({ content })
  if (result?.ok !== true || typeof result.safe !== 'boolean') throw new ServerError('The abuse guard could not complete the scan. Check its setup and try again.', { status: 503, code: result?.code || 'security-guard-scan-failed' })
  res.json({ safe: result.safe, code: result.code, layers: result.layers, findings: result.findings || [] })
}))

router.post('/security-guard/install', asyncHandler(async (req, res) => {
  const emit = emitter(req)
  const result = await installModelAbuseGuard({
    onEvent: ({ event, message, stage }) => emit(event, message, { scope: 'security-guard', stage }),
  })
  if (!result?.ok) {
    const code = result?.code || 'security-guard-install-failed'
    const message = code === 'security-guard-huggingface-token-required'
      ? 'Add a Hugging Face read token before installing Prompt Guard.'
      : code === 'security-guard-huggingface-access-required'
        ? 'Hugging Face has not granted Prompt Guard access yet. Submit the usage request on its model card, then retry.'
        : code === 'security-guard-python-unavailable'
          ? 'Install Python 3.10 or newer on this machine, restart PortOS if needed to detect it, then refresh Abuse Guard status.'
          : code === 'security-guard-self-test-failed'
            ? `Prompt Guard could not complete its local verification. Repair the dedicated runtime from ${ABUSE_GUARD_PAGE_BREADCRUMB} before retrying.`
            : code === 'security-guard-runtime-install-failed'
              ? `Classifier package installation failed. Check internet access and Python compatibility, then retry from ${ABUSE_GUARD_PAGE_BREADCRUMB}.`
        : code
    const detail = result?.diagnostic
    const actionableMessage = detail ? `${message} ${detail.message} ${detail.action}` : message
    emit('error', actionableMessage, { scope: 'security-guard', stage: detail?.stage })
    throw new ServerError(actionableMessage, { status: 502, code })
  }
  res.json(result)
}))

router.post('/security-guard/install/cancel', asyncHandler(async (_req, res) => {
  cancelModelAbuseGuardInstall()
  res.json({ cancelled: true })
}))

export default router
