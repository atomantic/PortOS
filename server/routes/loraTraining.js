/** Compatibility response for URLs from older clients. */
import { Router } from 'express';
import { refuseRetiredTraining } from '../lib/retiredLoraTraining.js';

const router = Router();
router.use(refuseRetiredTraining);

export default router;
