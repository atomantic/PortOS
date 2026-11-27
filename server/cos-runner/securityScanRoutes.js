import { securityScanRequestSchema } from '../lib/securityScanEvidence.js';
import { bodyErrorMessage } from './requestSchemas.js';

export function registerSecurityScanRoutes(app, {
  lifecycle, securityScans, assertDatabaseAdmission,
}) {
  app.post('/agents/:agentId/security-scan', async (req, res) => {
    const parsed = securityScanRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ error: bodyErrorMessage(parsed.error) });
    if (lifecycle.rejectSpawn(res)) return;
    try {
      assertDatabaseAdmission();
      res.json(await securityScans.start(req.params.agentId, parsed.data));
    } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
  });
  app.post('/agents/:agentId/security-scan/stop', async (req, res) => {
    try { res.json({ evidence: await securityScans.stop(req.params.agentId) }); }
    catch (err) { res.status(err.status || 500).json({ error: err.message }); }
  });
  app.get('/agents/:agentId/security-scan', async (req, res) => {
    try { res.json({ evidence: await securityScans.read(req.params.agentId) }); }
    catch (err) { res.status(err.status || 500).json({ error: err.message }); }
  });
}
