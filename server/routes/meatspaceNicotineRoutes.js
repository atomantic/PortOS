import { Router } from 'express';
import {
  nicotineLogSchema,
  nicotineUpdateSchema,
  customNicotineProductSchema,
  customNicotineProductUpdateSchema,
} from '../lib/meatspaceValidation.js';
import * as nicotine from '../services/meatspace/meatspaceNicotine.js';
import { createSubstanceRouter } from './meatspaceSubstanceRouter.js';
import { createSubstanceCustomRouter } from './meatspaceSubstanceCustomRouter.js';

const logRoutes = createSubstanceRouter({
  schemas: {
    log: nicotineLogSchema,
    update: nicotineUpdateSchema,
  },
  service: {
    summary: nicotine.getNicotineSummary,
    daily: nicotine.getDailyNicotine,
    log: nicotine.logNicotine,
    update: nicotine.updateNicotine,
    remove: nicotine.removeNicotine,
  },
  entryLabel: 'Nicotine entry',
});

const customRoutes = createSubstanceCustomRouter({
  schemas: {
    create: customNicotineProductSchema,
    update: customNicotineProductUpdateSchema,
  },
  service: {
    list: nicotine.getCustomProducts,
    add: nicotine.addCustomProduct,
    update: nicotine.updateCustomProduct,
    remove: nicotine.removeCustomProduct,
  },
  itemLabel: 'Custom product',
});

const router = Router();
router.use(logRoutes);
router.use('/custom-products', customRoutes);

export default router;
