import { Router } from 'express';
import * as git from '../services/git.js';

const router = Router();

// GET /api/git/:appId - Get git info for an app
router.get('/:appId', async (req, res, next) => {
  const { appId } = req.params;

  // Get app to find its path
  const apps = req.app.get('apps');
  const app = apps?.find(a => a.id === appId);

  if (!app) {
    return res.status(404).json({ error: 'App not found' });
  }

  const info = await git.getGitInfo(app.repoPath).catch(err => {
    res.status(500).json({ error: err.message });
    return undefined;
  });

  if (info) res.json(info);
});

// POST /api/git/status - Get status for a path
router.post('/status', async (req, res, next) => {
  const { path } = req.body;

  if (!path) {
    return res.status(400).json({ error: 'path is required' });
  }

  const status = await git.getStatus(path).catch(err => {
    res.status(500).json({ error: err.message });
    return undefined;
  });

  if (status) res.json(status);
});

// POST /api/git/diff - Get diff for a path
router.post('/diff', async (req, res, next) => {
  const { path, staged } = req.body;

  if (!path) {
    return res.status(400).json({ error: 'path is required' });
  }

  const diff = await git.getDiff(path, staged).catch(err => {
    res.status(500).json({ error: err.message });
    return undefined;
  });

  if (diff !== undefined) res.json({ diff });
});

// POST /api/git/commits - Get recent commits
router.post('/commits', async (req, res, next) => {
  const { path, limit = 10 } = req.body;

  if (!path) {
    return res.status(400).json({ error: 'path is required' });
  }

  const commits = await git.getCommits(path, limit).catch(err => {
    res.status(500).json({ error: err.message });
    return undefined;
  });

  if (commits) res.json({ commits });
});

// POST /api/git/stage - Stage files
router.post('/stage', async (req, res, next) => {
  const { path, files } = req.body;

  if (!path || !files) {
    return res.status(400).json({ error: 'path and files are required' });
  }

  const result = await git.stageFiles(path, files).catch(err => {
    res.status(500).json({ error: err.message });
    return undefined;
  });

  if (result) res.json({ success: true });
});

// POST /api/git/unstage - Unstage files
router.post('/unstage', async (req, res, next) => {
  const { path, files } = req.body;

  if (!path || !files) {
    return res.status(400).json({ error: 'path and files are required' });
  }

  const result = await git.unstageFiles(path, files).catch(err => {
    res.status(500).json({ error: err.message });
    return undefined;
  });

  if (result) res.json({ success: true });
});

// POST /api/git/commit - Create a commit
router.post('/commit', async (req, res, next) => {
  const { path, message } = req.body;

  if (!path || !message) {
    return res.status(400).json({ error: 'path and message are required' });
  }

  const result = await git.commit(path, message).catch(err => {
    res.status(500).json({ error: err.message });
    return undefined;
  });

  if (result) res.json(result);
});

// POST /api/git/info - Get full git info for a path
router.post('/info', async (req, res, next) => {
  const { path } = req.body;

  if (!path) {
    return res.status(400).json({ error: 'path is required' });
  }

  const info = await git.getGitInfo(path).catch(err => {
    res.status(500).json({ error: err.message });
    return undefined;
  });

  if (info) res.json(info);
});

export default router;
