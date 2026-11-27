import { Router } from 'express';
import {
  drinkLogSchema,
  drinkUpdateSchema,
  customDrinkSchema,
  customDrinkUpdateSchema,
} from '../lib/meatspaceValidation.js';
import * as alcohol from '../services/meatspace/meatspaceAlcohol.js';
import { createSubstanceRouter } from './meatspaceSubstanceRouter.js';
import { createSubstanceCustomRouter } from './meatspaceSubstanceCustomRouter.js';

const logRoutes = createSubstanceRouter({
  schemas: {
    log: drinkLogSchema,
    update: drinkUpdateSchema,
  },
  service: {
    summary: alcohol.getAlcoholSummary,
    daily: alcohol.getDailyAlcohol,
    log: alcohol.logDrink,
    update: alcohol.updateDrink,
    remove: alcohol.removeDrink,
  },
  entryLabel: 'Drink entry',
});

const customRoutes = createSubstanceCustomRouter({
  schemas: {
    create: customDrinkSchema,
    update: customDrinkUpdateSchema,
  },
  service: {
    list: alcohol.getCustomDrinks,
    add: alcohol.addCustomDrink,
    update: alcohol.updateCustomDrink,
    remove: alcohol.removeCustomDrink,
  },
  itemLabel: 'Custom drink',
});

const router = Router();
router.use(logRoutes);
router.use('/custom-drinks', customRoutes);

export default router;
