/**
 * Brain CRUD Routes
 *
 * Create/read/update/delete for the four brain entity collections
 * (People, Projects, Ideas, Admin) plus standalone Memories.
 */

import { Router } from 'express';
import * as brainService from '../services/brain.js';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { validateRequest, isPaginationRequested, paginateArray } from '../lib/validation.js';
import { partialWithoutDefaults } from '../lib/zodCompat.js';
import {
  peopleInputSchema,
  projectInputSchema,
  ideaInputSchema,
  adminInputSchema,
  memoryInputSchema
} from '../lib/brainValidation.js';

const router = Router();

// =============================================================================
// PEOPLE CRUD
// =============================================================================

router.get('/people', asyncHandler(async (req, res) => {
  const people = await brainService.getPeople();
  if (!isPaginationRequested(req.query)) {
    return res.json(people);
  }
  const { items, total, limit, offset } = paginateArray(people, req.query, { defaultLimit: 50, maxLimit: 500 });
  res.json({ people: items, total, limit, offset });
}));

router.get('/people/:id', asyncHandler(async (req, res) => {
  const person = await brainService.getPersonById(req.params.id);
  if (!person) {
    throw new ServerError('Person not found', { status: 404, code: 'NOT_FOUND' });
  }
  res.json(person);
}));

router.post('/people', asyncHandler(async (req, res) => {
  const data = validateRequest(peopleInputSchema, req.body);
  const person = await brainService.createPerson(data);
  res.status(201).json(person);
}));

router.put('/people/:id', asyncHandler(async (req, res) => {
  const data = validateRequest(peopleInputSchema.partial(), req.body);
  const person = await brainService.updatePerson(req.params.id, data);
  if (!person) {
    throw new ServerError('Person not found', { status: 404, code: 'NOT_FOUND' });
  }
  res.json(person);
}));

router.delete('/people/:id', asyncHandler(async (req, res) => {
  const deleted = await brainService.deletePerson(req.params.id);
  if (!deleted) {
    throw new ServerError('Person not found', { status: 404, code: 'NOT_FOUND' });
  }
  res.status(204).send();
}));

// =============================================================================
// PROJECTS CRUD
// =============================================================================

router.get('/projects', asyncHandler(async (req, res) => {
  const { status } = req.query;
  const filters = status ? { status } : undefined;
  const projects = await brainService.getProjects(filters);
  if (!isPaginationRequested(req.query)) {
    return res.json(projects);
  }
  const { items, total, limit, offset } = paginateArray(projects, req.query, { defaultLimit: 50, maxLimit: 500 });
  res.json({ projects: items, total, limit, offset });
}));

router.get('/projects/:id', asyncHandler(async (req, res) => {
  const project = await brainService.getProjectById(req.params.id);
  if (!project) {
    throw new ServerError('Project not found', { status: 404, code: 'NOT_FOUND' });
  }
  res.json(project);
}));

router.post('/projects', asyncHandler(async (req, res) => {
  const data = validateRequest(projectInputSchema, req.body);
  const project = await brainService.createProject(data);
  res.status(201).json(project);
}));

router.put('/projects/:id', asyncHandler(async (req, res) => {
  const data = validateRequest(partialWithoutDefaults(projectInputSchema), req.body);
  const project = await brainService.updateProject(req.params.id, data);
  if (!project) {
    throw new ServerError('Project not found', { status: 404, code: 'NOT_FOUND' });
  }
  res.json(project);
}));

router.delete('/projects/:id', asyncHandler(async (req, res) => {
  const deleted = await brainService.deleteProject(req.params.id);
  if (!deleted) {
    throw new ServerError('Project not found', { status: 404, code: 'NOT_FOUND' });
  }
  res.status(204).send();
}));

// =============================================================================
// IDEAS CRUD
// =============================================================================

router.get('/ideas', asyncHandler(async (req, res) => {
  const { status } = req.query;
  const filters = status ? { status } : undefined;
  const ideas = await brainService.getIdeas(filters);
  if (!isPaginationRequested(req.query)) {
    return res.json(ideas);
  }
  const { items, total, limit, offset } = paginateArray(ideas, req.query, { defaultLimit: 50, maxLimit: 500 });
  res.json({ ideas: items, total, limit, offset });
}));

router.get('/ideas/:id', asyncHandler(async (req, res) => {
  const idea = await brainService.getIdeaById(req.params.id);
  if (!idea) {
    throw new ServerError('Idea not found', { status: 404, code: 'NOT_FOUND' });
  }
  res.json(idea);
}));

router.post('/ideas', asyncHandler(async (req, res) => {
  const data = validateRequest(ideaInputSchema, req.body);
  const idea = await brainService.createIdea(data);
  res.status(201).json(idea);
}));

router.put('/ideas/:id', asyncHandler(async (req, res) => {
  const data = validateRequest(partialWithoutDefaults(ideaInputSchema), req.body);
  const idea = await brainService.updateIdea(req.params.id, data);
  if (!idea) {
    throw new ServerError('Idea not found', { status: 404, code: 'NOT_FOUND' });
  }
  res.json(idea);
}));

router.delete('/ideas/:id', asyncHandler(async (req, res) => {
  const deleted = await brainService.deleteIdea(req.params.id);
  if (!deleted) {
    throw new ServerError('Idea not found', { status: 404, code: 'NOT_FOUND' });
  }
  res.status(204).send();
}));

// =============================================================================
// ADMIN CRUD
// =============================================================================

router.get('/admin', asyncHandler(async (req, res) => {
  const { status } = req.query;
  const filters = status ? { status } : undefined;
  const adminItems = await brainService.getAdminItems(filters);
  if (!isPaginationRequested(req.query)) {
    return res.json(adminItems);
  }
  const { items, total, limit, offset } = paginateArray(adminItems, req.query, { defaultLimit: 50, maxLimit: 500 });
  res.json({ admin: items, total, limit, offset });
}));

router.get('/admin/:id', asyncHandler(async (req, res) => {
  const item = await brainService.getAdminById(req.params.id);
  if (!item) {
    throw new ServerError('Admin item not found', { status: 404, code: 'NOT_FOUND' });
  }
  res.json(item);
}));

router.post('/admin', asyncHandler(async (req, res) => {
  const data = validateRequest(adminInputSchema, req.body);
  const item = await brainService.createAdminItem(data);
  res.status(201).json(item);
}));

router.put('/admin/:id', asyncHandler(async (req, res) => {
  const data = validateRequest(partialWithoutDefaults(adminInputSchema), req.body);
  const item = await brainService.updateAdminItem(req.params.id, data);
  if (!item) {
    throw new ServerError('Admin item not found', { status: 404, code: 'NOT_FOUND' });
  }
  res.json(item);
}));

router.delete('/admin/:id', asyncHandler(async (req, res) => {
  const deleted = await brainService.deleteAdminItem(req.params.id);
  if (!deleted) {
    throw new ServerError('Admin item not found', { status: 404, code: 'NOT_FOUND' });
  }
  res.status(204).send();
}));

// =============================================================================
// MEMORIES CRUD
// =============================================================================

router.get('/memories', asyncHandler(async (req, res) => {
  const memories = await brainService.getMemoryEntries();
  if (!isPaginationRequested(req.query)) {
    return res.json(memories);
  }
  const { items, total, limit, offset } = paginateArray(memories, req.query, { defaultLimit: 50, maxLimit: 500 });
  res.json({ memories: items, total, limit, offset });
}));

router.get('/memories/:id', asyncHandler(async (req, res) => {
  const memory = await brainService.getMemoryEntryById(req.params.id);
  if (!memory) {
    throw new ServerError('Memory not found', { status: 404, code: 'NOT_FOUND' });
  }
  res.json(memory);
}));

router.post('/memories', asyncHandler(async (req, res) => {
  const data = validateRequest(memoryInputSchema, req.body);
  const memory = await brainService.createMemoryEntry(data);
  res.status(201).json(memory);
}));

router.put('/memories/:id', asyncHandler(async (req, res) => {
  const data = validateRequest(memoryInputSchema.partial(), req.body);
  const memory = await brainService.updateMemoryEntry(req.params.id, data);
  if (!memory) {
    throw new ServerError('Memory not found', { status: 404, code: 'NOT_FOUND' });
  }
  res.json(memory);
}));

router.delete('/memories/:id', asyncHandler(async (req, res) => {
  const deleted = await brainService.deleteMemoryEntry(req.params.id);
  if (!deleted) {
    throw new ServerError('Memory not found', { status: 404, code: 'NOT_FOUND' });
  }
  res.status(204).send();
}));

export default router;
