import express from 'express';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { failValidation } from '../lib/errorHandler.js';
import { remoteDesktopBroker } from '../services/remoteDesktop.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const viewerTemplate = readFileSync(join(__dirname, '..', 'views', 'remote-desktop.html'), 'utf8');
const vendorRoot = join(__dirname, '..', 'node_modules', '@novnc', 'novnc');
const router = express.Router();
// A repeated `token` parameter arrives as an array; refuse it rather than let
// the broker see a non-string.
const viewerQuerySchema = z.object({ token: z.string().max(512).optional() });

router.use('/vendor', express.static(vendorRoot, {
  index: false,
  immutable: true,
  maxAge: '1y',
}));

router.get('/', (req, res) => {
  const parsed = viewerQuerySchema.safeParse(req.query);
  if (!parsed.success) failValidation(parsed);
  const { token } = parsed.data;
  if (!remoteDesktopBroker.hasSession(token)) {
    res.status(401).type('text/plain').send('This remote desktop link is invalid or expired. Return to PortDeck and start a new session.');
    return;
  }
  res.set('Cache-Control', 'no-store');
  res.set('Referrer-Policy', 'no-referrer');
  res.type('html').send(viewerTemplate.replaceAll('__REMOTE_DESKTOP_TOKEN__', token));
});

export default router;
