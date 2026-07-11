/**
 * App icon serving + detection.
 *
 *   GET  /:id/icon        → image bytes (ETag / CSP-guarded SVG)
 *   POST /detect-icons    → { success, detected, total }  (all apps)
 *   POST /:id/detect-icon → { success, detected, appIconPath }  (single app)
 */

import { Router } from 'express';
import { readFile, stat } from 'fs/promises';
import { extname } from 'path';
import * as appsService from '../../services/apps.js';
import { notifyAppsChanged } from '../../services/apps.js';
import { asyncHandler, ServerError } from '../../lib/errorHandler.js';
import { detectAppIcon, getIconContentType, isUsableSvg } from '../../services/appIconDetect.js';
import { loadApp, pathExists } from './shared.js';

const router = Router();

// GET /api/apps/:id/icon - Serve the app's detected icon image
router.get('/:id/icon', loadApp, asyncHandler(async (req, res) => {
  const app = req.loadedApp;

  // Use stored appIconPath, or detect on-the-fly. Stored SVGs that embed an
  // external <image href="..."> render blank under the route's `default-src
  // 'none'` CSP, so re-detect when the cached path is an unusable SVG (e.g.
  // PortOS's own favicon.svg, which wraps a /portos-logo.png reference) —
  // otherwise installs that resolved an icon BEFORE the detector learned to
  // skip these stay broken until the user manually re-detects.
  let iconPath = app.appIconPath;
  const stale =
    !iconPath ||
    !await pathExists(iconPath) ||
    (extname(iconPath).toLowerCase() === '.svg' && !await isUsableSvg(iconPath));
  if (stale) {
    iconPath = await detectAppIcon(app.repoPath, app.type);
    if (iconPath && iconPath !== app.appIconPath) {
      await appsService.updateApp(app.id, { appIconPath: iconPath });
    }
  }

  if (!iconPath || !await pathExists(iconPath)) {
    throw new ServerError('No app icon found', { status: 404 });
  }

  const contentType = getIconContentType(iconPath);
  const iconStat = await stat(iconPath).catch(e => e.code === 'ENOENT' ? null : Promise.reject(e));
  if (!iconStat) throw new ServerError('No app icon found', { status: 404 });
  const etag = `W/"${iconStat.mtimeMs.toString(36)}-${iconStat.size.toString(36)}"`;

  res.set('Content-Type', contentType);
  res.set('Cache-Control', 'public, max-age=3600');
  res.set('ETag', etag);
  res.set('X-Content-Type-Options', 'nosniff');
  if (contentType === 'image/svg+xml') {
    res.set('Content-Disposition', 'inline; filename="icon.svg"');
    res.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'");
  }

  const ifNoneMatch = req.headers['if-none-match'];
  if (ifNoneMatch) {
    const tags = ifNoneMatch.split(',').map(v => v.trim());
    if (tags.includes('*') || tags.includes(etag)) {
      return res.status(304).end();
    }
  }

  const iconData = await readFile(iconPath).catch(e => e.code === 'ENOENT' ? null : Promise.reject(e));
  if (!iconData) throw new ServerError('No app icon found', { status: 404 });
  res.send(iconData);
}));

// POST /api/apps/detect-icons - Detect and persist app icons for all apps
router.post('/detect-icons', asyncHandler(async (req, res) => {
  const apps = await appsService.getAllApps();
  let detected = 0;

  for (const app of apps) {
    if (!app.repoPath || !await pathExists(app.repoPath)) continue;
    // Skip apps that already have a valid icon path
    if (app.appIconPath && await pathExists(app.appIconPath)) continue;

    const iconPath = await detectAppIcon(app.repoPath, app.type);
    if (iconPath) {
      await appsService.updateApp(app.id, { appIconPath: iconPath });
      detected++;
      console.log(`🎨 Detected icon for ${app.name}: ${iconPath.split('/').pop()}`);
    }
  }

  if (detected > 0) notifyAppsChanged('detect-icons');
  console.log(`🎨 Icon detection complete: ${detected}/${apps.length} apps`);
  res.json({ success: true, detected, total: apps.length });
}));

// POST /api/apps/:id/detect-icon - Detect and persist app icon for a single app
router.post('/:id/detect-icon', loadApp, asyncHandler(async (req, res) => {
  const app = req.loadedApp;
  if (!app.repoPath || !await pathExists(app.repoPath)) {
    throw new ServerError('App repoPath is missing or inaccessible', { status: 400, code: 'INVALID_REPO_PATH' });
  }

  const iconPath = await detectAppIcon(app.repoPath, app.type);
  if (!iconPath) {
    console.log(`🎨 No icon detected for ${app.name}`);
    res.json({ success: true, detected: false, appIconPath: null });
    return;
  }

  await appsService.updateApp(app.id, { appIconPath: iconPath });
  notifyAppsChanged('detect-icon');
  console.log(`🎨 Detected icon for ${app.name}: ${iconPath.split('/').pop()}`);
  res.json({ success: true, detected: true, appIconPath: iconPath });
}));

export default router;
