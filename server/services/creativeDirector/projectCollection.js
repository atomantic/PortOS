import { createCollection } from '../mediaCollections.js';

/**
 * The media collection a new project files its renders into: the job
 * collection a Creative Commission run supplies, else the project's own.
 * Shared by the DB and file backends.
 */
export async function projectCollectionFor(input, projectId) {
  if (typeof input.collectionId === 'string' && input.collectionId) return { collectionId: input.collectionId };
  const collection = await createCollection({
    name: `Creative Director: ${input.name}`,
    description: `Auto-created for project ${projectId}`,
    source: 'auto',
  });
  return { collectionId: collection.id };
}
