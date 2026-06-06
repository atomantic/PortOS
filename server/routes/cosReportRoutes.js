/**
 * CoS Reports, Briefings, Scripts, Watcher, and Activity Routes
 */

import { Router } from 'express';
import { z } from 'zod';
import * as cos from '../services/cos.js';
import * as taskWatcher from '../services/taskWatcher.js';
import * as appActivity from '../services/appActivity.js';
import * as claudeChangelog from '../services/claudeChangelog.js';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validation.js';

const router = Router();

// `since` is the client's last-visit marker (ISO-8601). Optional and tolerant:
// `getWhileAwayActivity` already clamps an absent/garbage/future marker to a
// 24h fallback, so a malformed value preprocesses to `undefined` (let the
// service apply its fallback) rather than 400-ing the dashboard card into a
// blank state. A valid datetime string passes through unchanged.
const whileAwayQuerySchema = z.object({
  since: z.preprocess(
    (v) => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? v : undefined),
    z.string().optional()
  )
});

// GET /api/cos/reports - List all reports
router.get('/reports', asyncHandler(async (req, res) => {
  const reports = await cos.listReports();
  res.json(reports);
}));

// GET /api/cos/reports/today - Get today's report
router.get('/reports/today', asyncHandler(async (req, res) => {
  const report = await cos.getTodayReport();
  res.json(report);
}));

// GET /api/cos/reports/:date - Get report by date
router.get('/reports/:date', asyncHandler(async (req, res) => {
  const report = await cos.getReport(req.params.date);
  if (!report) {
    throw new ServerError('Report not found', { status: 404, code: 'NOT_FOUND' });
  }
  res.json(report);
}));

// POST /api/cos/reports/generate - Generate report for date
router.post('/reports/generate', asyncHandler(async (req, res) => {
  const { date } = req.body;
  const report = await cos.generateReport(date);
  res.json(report);
}));

// GET /api/cos/briefings - List all briefings
router.get('/briefings', asyncHandler(async (req, res) => {
  const briefings = await cos.listBriefings();
  res.json({ briefings });
}));

// GET /api/cos/briefings/latest - Get latest briefing
router.get('/briefings/latest', asyncHandler(async (req, res) => {
  const briefing = await cos.getLatestBriefing();
  res.json(briefing);
}));

// GET /api/cos/briefings/:date - Get briefing by date
router.get('/briefings/:date', asyncHandler(async (req, res) => {
  const briefing = await cos.getBriefing(req.params.date);
  if (!briefing) {
    throw new ServerError('Briefing not found', { status: 404, code: 'NOT_FOUND' });
  }
  res.json(briefing);
}));

// GET /api/cos/claude-changelog - Get Claude Code changelog (fetches Atom feed)
router.get('/claude-changelog', asyncHandler(async (req, res) => {
  const result = await claudeChangelog.checkChangelog();
  res.json(result);
}));

// GET /api/cos/claude-changelog/cached - Get cached changelog without fetching
router.get('/claude-changelog/cached', asyncHandler(async (req, res) => {
  const result = await claudeChangelog.getCachedChangelog();
  res.json(result);
}));

// GET /api/cos/scripts - List generated scripts
router.get('/scripts', asyncHandler(async (req, res) => {
  const scripts = await cos.listScripts();
  res.json(scripts);
}));

// GET /api/cos/scripts/:name - Get script content
router.get('/scripts/:name', asyncHandler(async (req, res) => {
  const script = await cos.getScript(req.params.name);
  if (!script) {
    throw new ServerError('Script not found', { status: 404, code: 'NOT_FOUND' });
  }
  res.json(script);
}));

// GET /api/cos/watcher - Get watcher status
router.get('/watcher', (req, res) => {
  res.json(taskWatcher.getWatcherStatus());
});

// GET /api/cos/app-activity - Get per-app activity data
router.get('/app-activity', asyncHandler(async (req, res) => {
  const activity = await appActivity.loadAppActivity();
  res.json(activity);
}));

// GET /api/cos/app-activity/:appId - Get activity for specific app
router.get('/app-activity/:appId', asyncHandler(async (req, res) => {
  const activity = await appActivity.getAppActivityById(req.params.appId);
  if (!activity) {
    res.json({ appId: req.params.appId, activity: null, message: 'No activity recorded for this app' });
    return;
  }
  res.json({ appId: req.params.appId, activity });
}));

// POST /api/cos/app-activity/:appId/clear-cooldown - Clear cooldown for an app
router.post('/app-activity/:appId/clear-cooldown', asyncHandler(async (req, res) => {
  const result = await appActivity.clearAppCooldown(req.params.appId);
  res.json({ success: true, appId: req.params.appId, activity: result });
}));

// GET /api/cos/activity/today - Get today's activity summary
router.get('/activity/today', asyncHandler(async (req, res) => {
  const activity = await cos.getTodayActivity();
  res.json(activity);
}));

// GET /api/cos/activity/while-away - What agents did since ?since=<ISO> (the
// client's last-visit marker). Powers the "While You Were Away" dashboard card.
router.get('/activity/while-away', asyncHandler(async (req, res) => {
  const { since } = validateRequest(whileAwayQuerySchema, req.query);
  const activity = await cos.getWhileAwayActivity(since);
  res.json(activity);
}));

export default router;
