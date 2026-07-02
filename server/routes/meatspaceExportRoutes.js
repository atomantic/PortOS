/**
 * Meatspace Export Routes
 *
 * MortalLoom-compatible JSON export — transforms PortOS daily-log + health files
 * into the MortalLoom AppData schema.
 */

import { Router } from 'express';
import { join } from 'path';
import crypto from 'node:crypto';
import { asyncHandler } from '../lib/errorHandler.js';
import { PATHS, readJSONFile } from '../lib/fileUtils.js';
import * as meatspaceService from '../services/meatspace.js';
import * as alcoholService from '../services/meatspaceAlcohol.js';
import * as nicotineService from '../services/meatspaceNicotine.js';
import * as healthService from '../services/meatspaceHealth.js';
import { getGoals } from '../services/identity.js';

const router = Router();

/**
 * GET /api/meatspace/export/mortalloom
 * Export all health data in MortalLoom-compatible JSON format.
 * Transforms PortOS daily-log + files into MortalLoom AppData schema.
 */
router.get('/export/mortalloom', asyncHandler(async (req, res) => {
  const [config, bloodData, epiData, eyeData, dailyLog, customDrinks, customNicotineProducts, goalsData] = await Promise.all([
    meatspaceService.getConfig(),
    healthService.getBloodTests(),
    healthService.getEpigeneticTests(),
    healthService.getEyeExams(),
    readJSONFile(join(PATHS.meatspace, 'daily-log.json'), { entries: [] }),
    alcoholService.getCustomDrinks(),
    nicotineService.getCustomProducts(),
    getGoals(),
  ]);

  const entries = dailyLog?.entries || [];

  const profile = {
    birthDate: config.birthDate || null,
    biologicalSex: config.sex || null,
    lifestyle: {
      smokingStatus: config.lifestyle?.smokingStatus ?? 'never',
      exerciseMinutesPerWeek: config.lifestyle?.exerciseMinutesPerWeek ?? 150,
      sleepHoursPerNight: config.lifestyle?.sleepHoursPerNight ?? 7.5,
      dietQuality: config.lifestyle?.dietQuality ?? 'good',
      stressLevel: config.lifestyle?.stressLevel ?? 'moderate',
      bmi: config.lifestyle?.bmi ?? null,
    },
  };

  const alcoholDrinks = [];
  for (const entry of entries) {
    if (!entry.alcohol?.drinks) continue;
    for (const drink of entry.alcohol.drinks) {
      alcoholDrinks.push({
        id: crypto.randomUUID(),
        name: drink.name,
        oz: drink.oz,
        abv: drink.abv,
        count: Math.max(1, Math.round(drink.count || 1)),
        date: entry.date,
      });
    }
  }

  const nicotineEntries = [];
  for (const entry of entries) {
    if (!entry.nicotine?.items) continue;
    for (const item of entry.nicotine.items) {
      nicotineEntries.push({
        id: crypto.randomUUID(),
        product: item.product,
        mgPerUnit: item.mgPerUnit,
        count: Math.max(1, Math.round(item.count || 1)),
        date: entry.date,
      });
    }
  }

  const bloodTests = (bloodData?.tests || []).map(test => {
    const { date, ...markers } = test;
    return { id: crypto.randomUUID(), date, markers };
  });

  // Derive body entries from daily log (avoids re-reading the file via getBodyHistory)
  const bodyEntries = entries
    .filter(e => e.body && Object.keys(e.body).length > 0)
    .map(e => ({
      id: crypto.randomUUID(),
      date: e.date,
      weightLbs: e.body.weightLbs ?? null,
      bodyFatPct: e.body.fatPct ?? null,
    }));

  const epigeneticTests = (epiData?.tests || []).map(test => ({
    id: crypto.randomUUID(),
    date: test.date,
    chronologicalAge: test.chronologicalAge,
    biologicalAge: test.biologicalAge,
    paceOfAging: test.paceOfAging ?? null,
    organScores: test.organScores ?? null,
  }));

  const eyeExams = (eyeData?.exams || []).map(exam => ({
    id: crypto.randomUUID(),
    date: exam.date,
    leftSphere: exam.leftSphere ?? null,
    leftCylinder: exam.leftCylinder ?? null,
    leftAxis: exam.leftAxis ?? null,
    rightSphere: exam.rightSphere ?? null,
    rightCylinder: exam.rightCylinder ?? null,
    rightAxis: exam.rightAxis ?? null,
  }));

  const alcoholPresets = customDrinks.map(d => ({
    id: crypto.randomUUID(),
    name: d.name,
    oz: d.oz,
    abv: d.abv,
  }));

  const nicotinePresets = customNicotineProducts.map(p => ({
    id: crypto.randomUUID(),
    name: p.name,
    mgPerUnit: p.mgPerUnit,
  }));

  const GOAL_STATUS_MAP = { active: 'active', paused: 'paused', completed: 'completed', abandoned: 'abandoned', archived: 'completed' };
  const goals = (goalsData?.goals || []).map(goal => {
    const rawCheckIns = (goal.checkIns || []).map(ci => ({
      id: crypto.randomUUID(),
      date: ci.date?.slice(0, 10) ?? ci.timestamp?.slice(0, 10) ?? goal.createdAt?.slice(0, 10),
      progressPct: ci.value ?? ci.progressPct ?? 0,
      note: ci.note ?? '',
    }));
    // Fall back to progressHistory entries as check-ins when no explicit checkIns exist
    const checkIns = rawCheckIns.length ? rawCheckIns : (goal.progressHistory || []).map(ph => ({
      id: crypto.randomUUID(),
      date: ph.date ?? ph.timestamp?.slice(0, 10),
      progressPct: ph.value ?? 0,
      note: '',
    }));

    const milestones = (goal.milestones || []).map(ms => ({
      id: crypto.randomUUID(),
      title: ms.title,
      completed: !!ms.completedAt,
      completedDate: ms.completedAt?.slice(0, 10) ?? null,
    }));

    const status = GOAL_STATUS_MAP[goal.status] ?? 'active';
    const priority = goal.urgency >= 0.7 ? 'high' : goal.urgency >= 0.4 ? 'medium' : 'low';

    return {
      id: crypto.randomUUID(),
      title: goal.title,
      notes: goal.description ?? '',
      createdDate: goal.createdAt?.slice(0, 10) ?? null,
      targetDate: goal.targetDate?.slice(0, 10) ?? null,
      completedDate: status === 'completed' ? (goal.updatedAt?.slice(0, 10) ?? null) : null,
      checkIns,
      milestones,
      checkInIntervalDays: 7,
      status,
      priority,
    };
  });

  const exportData = {
    profile,
    alcoholDrinks,
    alcoholPresets,
    nicotineEntries,
    nicotinePresets,
    bloodTests,
    eyeExams,
    epigeneticTests,
    bodyEntries,
    goals,
  };

  res.setHeader('Content-Disposition', 'attachment; filename="MortalLoom-export.json"');
  res.setHeader('Content-Type', 'application/json');
  res.json(exportData);
}));

export default router;
