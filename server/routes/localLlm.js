import { Router } from 'express'
import { observeModelMutations } from '../services/modelObservation.js'
import layaMlxRoutes from './localLlm/layaMlxRoutes.js'
import catalogRoutes from './localLlm/catalogRoutes.js'
import securityGuardRoutes from './localLlm/securityGuardRoutes.js'
import jevRoutes from './localLlm/jevRoutes.js'
import backendRoutes from './localLlm/backendRoutes.js'
import playgroundRoutes from './localLlm/playgroundRoutes.js'
import evaluationRoutes from './localLlm/evaluationRoutes.js'
import localLlmRuntimes from './localLlmRuntimes.js'

const router = Router()
// Invalidate observations after successful mutations from any child router.
router.use(observeModelMutations('loaded-models', 'provider-readiness'))

router.use(layaMlxRoutes)
router.use(catalogRoutes)
router.use(securityGuardRoutes)
router.use(jevRoutes)
router.use(backendRoutes)
router.use(playgroundRoutes)
router.use(evaluationRoutes)
router.use(localLlmRuntimes)

export default router
