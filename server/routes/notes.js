/**
 * Notes API Routes (Obsidian Vault Manager)
 *
 * Manages Obsidian vaults from iCloud directories.
 * Reads, writes, searches, and graphs markdown notes.
 */

import { Router } from 'express';
import * as obsidian from '../services/obsidian.js';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validation.js';
import {
  vaultInputSchema,
  vaultUpdateSchema,
  notePathSchema,
  createNoteSchema,
  updateNoteSchema,
  searchQuerySchema,
  scanQuerySchema
} from '../lib/notesValidation.js';

const router = Router();

const NOT_FOUND_CODES = new Set(['VAULT_NOT_FOUND', 'NOTE_NOT_FOUND']);
// The note exists but iCloud reports its bytes as evicted — usually transient
// (it heals once the background `brctl download` completes), so 503, not 404
// (gone) or 400 (your request was wrong). Not ALWAYS transient: the screen can
// false-positive on a genuinely-local sparse/compressed file, which no amount of
// retrying clears — the service says so in the message and the UI offers a
// force-save override on the second refusal (#3717).
const UNAVAILABLE_CODES = new Set(['NOTE_EVICTED']);
const errorStatus = (code) => {
  if (NOT_FOUND_CODES.has(code)) return 404;
  if (UNAVAILABLE_CODES.has(code)) return 503;
  return 400;
};

function throwOnError(result, fallbackMessage) {
  if (result?.error) {
    throw new ServerError(result.message || result.error, {
      status: errorStatus(result.error),
      code: result.error
    });
  }
  if (result === null) {
    throw new ServerError(fallbackMessage || 'Not found', { status: 404, code: 'NOT_FOUND' });
  }
}

// =============================================================================
// VAULT MANAGEMENT
// =============================================================================

router.get('/vaults', asyncHandler(async (req, res) => {
  const vaults = await obsidian.getVaults();
  res.json(vaults);
}));

router.get('/detect', asyncHandler(async (req, res) => {
  const detected = await obsidian.detectVaults();
  res.json(detected);
}));

router.post('/vaults', asyncHandler(async (req, res) => {
  const data = validateRequest(vaultInputSchema, req.body);
  const result = await obsidian.addVault(data);
  throwOnError(result);
  res.status(201).json(result);
}));

router.put('/vaults/:id', asyncHandler(async (req, res) => {
  const data = validateRequest(vaultUpdateSchema, req.body);
  const result = await obsidian.updateVault(req.params.id, data);
  throwOnError(result, 'Vault not found');
  res.json(result);
}));

router.delete('/vaults/:id', asyncHandler(async (req, res) => {
  const deleted = await obsidian.removeVault(req.params.id);
  if (!deleted) {
    throw new ServerError('Vault not found', { status: 404, code: 'NOT_FOUND' });
  }
  res.status(204).send();
}));

// =============================================================================
// NOTE OPERATIONS
// =============================================================================

router.get('/vaults/:id/scan', asyncHandler(async (req, res) => {
  const { folder, limit, offset } = validateRequest(scanQuerySchema, req.query);
  const result = await obsidian.scanVault(req.params.id, { folder });
  throwOnError(result);

  const total = result.notes.length;
  const notes = result.notes.slice(offset, offset + limit);
  // Forward the skipped-because-unavailable count (the other readers pass their
  // whole result through; this one reshapes for pagination and would otherwise
  // drop it, leaving the client unable to tell a short vault from an offloaded one).
  res.json({ vault: result.vault, notes, total, skippedUnavailable: result.skippedUnavailable ?? 0 });
}));

router.get('/vaults/:id/note', asyncHandler(async (req, res) => {
  const { path } = validateRequest(notePathSchema, req.query);
  const includeBacklinks = req.query.backlinks !== 'false';
  const result = await obsidian.getNote(req.params.id, path, { includeBacklinks });
  throwOnError(result);
  res.json(result);
}));

router.post('/vaults/:id/note', asyncHandler(async (req, res) => {
  const { path, content } = validateRequest(createNoteSchema, req.body);
  const result = await obsidian.createNote(req.params.id, path, content);
  throwOnError(result);
  res.status(201).json(result);
}));

router.put('/vaults/:id/note', asyncHandler(async (req, res) => {
  const { path } = validateRequest(notePathSchema, req.query);
  const { content, force } = validateRequest(updateNoteSchema, req.body);
  const result = await obsidian.updateNote(req.params.id, path, content, { force });
  throwOnError(result);
  res.json(result);
}));

router.delete('/vaults/:id/note', asyncHandler(async (req, res) => {
  const { path } = validateRequest(notePathSchema, req.query);
  const result = await obsidian.deleteNote(req.params.id, path);
  if (result === true) {
    res.status(204).send();
    return;
  }
  throwOnError(result);
}));

// =============================================================================
// SEARCH & DISCOVERY
// =============================================================================

router.get('/vaults/:id/search', asyncHandler(async (req, res) => {
  const { q, limit } = validateRequest(searchQuerySchema, req.query);
  const result = await obsidian.searchNotes(req.params.id, q);
  throwOnError(result);
  result.results = result.results.slice(0, limit);
  res.json(result);
}));

router.get('/vaults/:id/tags', asyncHandler(async (req, res) => {
  const result = await obsidian.getVaultTags(req.params.id);
  throwOnError(result);
  res.json(result);
}));

router.get('/vaults/:id/folders', asyncHandler(async (req, res) => {
  const result = await obsidian.getVaultFolders(req.params.id);
  throwOnError(result);
  res.json(result);
}));

router.get('/vaults/:id/graph', asyncHandler(async (req, res) => {
  const result = await obsidian.getVaultGraph(req.params.id);
  throwOnError(result);
  res.json(result);
}));

export default router;
