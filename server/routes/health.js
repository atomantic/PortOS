import { Router } from 'express';

const router = Router();

router.get('/health', (req, res) => {
  console.log('💓 GET /api/health');
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    version: '0.1.0'
  });
});

export default router;
