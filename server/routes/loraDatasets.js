/** Dataset and caption routes are retired (#13536); every method and path returns 410. */
import { Router } from 'express';
import { refuseRetiredTraining } from '../lib/retiredLoraTraining.js';

const router = Router();
router.all('/{*path}', refuseRetiredTraining);

export default router;
