/**
 * Chief of Staff API Routes
 */

import { Router } from 'express';
import statusRoutes from './cosStatusRoutes.js';
import taskRoutes from './cosTaskRoutes.js';
import agentRoutes from './cosAgentRoutes.js';
import reportRoutes from './cosReportRoutes.js';
import learningRoutes from './cosLearningRoutes.js';
import scheduleRoutes from './cosScheduleRoutes.js';
import jobRoutes from './cosJobRoutes.js';
import templateRoutes from './cosTemplateRoutes.js';
import insightRoutes from './cosInsightRoutes.js';

const router = Router();

router.use(statusRoutes);
router.use(taskRoutes);
router.use(agentRoutes);
router.use(reportRoutes);
router.use(learningRoutes);
router.use(scheduleRoutes);
router.use(jobRoutes);
router.use(templateRoutes);
router.use(insightRoutes);

export default router;
