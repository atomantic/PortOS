import { useCallback, useEffect, useState } from 'react';
import toast from '../components/ui/Toast';
import {
  analyzeImport, commitImport, retryImporterIssues, createStorySession,
} from '../services/api';

// Mirror Importer.jsx's commit picker — only these arc fields are sent on commit.
const ARC_FIELDS_TO_COMMIT = ['logline', 'summary', 'protagonistArc', 'themes', 'shape'];

export const pickArcFields = (arc) => {
  if (!arc) return null;
  const out = {};
  for (const k of ARC_FIELDS_TO_COMMIT) if (arc[k] !== undefined) out[k] = arc[k];
  return out;
};

export const IMPORT_INTAKE_INITIAL = {
  universeName: '',
  seriesName: '',
  contentType: 'comic-script',
  source: '',
  llm: { provider: '', model: '' },
  preview: null,
  analyzing: false,
  retrying: false,
  committing: false,
  // Set after a partial commit (universe/series/arc/canon persisted, issues
  // rolled back). The retry then drops arc + seasons + canon so it only
  // re-creates the issues — re-sending the full payload would clobber the
  // persisted state and risk duplicate issues. Mirrors Importer.jsx.
  arcAlreadyPersisted: false,
  // Set once commitImport fully succeeds (issues created) but createStorySession
  // then failed — a re-click must skip commitImport entirely and resume at
  // session creation, otherwise it re-creates the already-created issues and
  // overwrites the arc.
  //
  // Both flags are a CACHE of the server's import session (#9943), not the
  // source of truth: a reload loses them, and re-analyzing the same text
  // re-seeds them from `preview.importSession`.
  committed: false,
};

// Story Builder "Import a finished work" intake: every field the import form
// collects, plus the analyze → commit → create-session workflow over them.
//
// This lives OUTSIDE the import panel on purpose (#3904). The Story Builder
// index renders its Seed and Import intake tabs by swapping components, so the
// import panel unmounts on every tab flip — holding the manuscript (up to 50k
// chars), the form fields, and a minute-long analysis result in that panel's
// own `useState` meant one click on "Start from an idea" destroyed all of it.
// Calling this hook from the always-mounted index keeps the state alive across
// tab switches AND lets an in-flight analyze/commit resolve into live state
// instead of into an unmounted component.
export default function useStoryImportIntake(onCreated) {
  const [state, setState] = useState(IMPORT_INTAKE_INITIAL);
  // `patch` takes a partial (or a function of the previous state returning one)
  // so callers never have to spread the whole bag.
  const patch = useCallback((next) => {
    setState((prev) => ({ ...prev, ...(typeof next === 'function' ? next(prev) : next) }));
  }, []);

  const { preview } = state;
  // Any path that clears the preview (analyze, Re-analyze) is a fresh attempt,
  // so the retry/committed state can't survive it — centralize the reset here.
  useEffect(() => {
    if (preview) return;
    setState((prev) => (prev.arcAlreadyPersisted || prev.committed
      ? { ...prev, arcAlreadyPersisted: false, committed: false }
      : prev));
  }, [preview]);

  const analyze = useCallback(async () => {
    const { universeName, seriesName, contentType, source, llm } = state;
    if (!universeName.trim() || !seriesName.trim() || !source.trim()) {
      toast.error('Universe name, series name, and source text are required'); return;
    }
    patch({ analyzing: true, preview: null });
    const res = await analyzeImport(
      {
        universeName: universeName.trim(), seriesName: seriesName.trim(), contentType, source,
        providerOverride: llm.provider || undefined, modelOverride: llm.model || undefined,
      },
      { silent: true },
    ).catch((err) => { toast.error(err?.message || 'Analyze failed'); return null; });
    if (res?.importSession?.status === 'committed') {
      toast.info('This manuscript was already imported — Import & build resumes without creating the issues again.');
    }
    patch({
      analyzing: false,
      ...(res ? {
        preview: res,
        committed: res.importSession?.status === 'committed',
        arcAlreadyPersisted: res.importSession?.status === 'arc-persisted',
      } : {}),
    });
  }, [state, patch]);

  const retryIssues = useCallback(async () => {
    const { contentType, source, seriesName, llm } = state;
    patch({ retrying: true });
    const res = await retryImporterIssues(
      {
        contentType, source, seriesName: seriesName.trim(), arcSummary: state.preview?.arcPreview?.summary || '',
        providerOverride: llm.provider || undefined, modelOverride: llm.model || undefined,
      },
      { silent: true },
    ).catch((err) => { toast.error(err?.message || 'Retry failed'); return null; });
    patch((prev) => ({
      retrying: false,
      ...(res ? { preview: { ...prev.preview, issueProposals: res.issueProposals || [], issueSplitFailed: false } } : {}),
    }));
  }, [state, patch]);

  const importAndBuild = useCallback(async () => {
    const { preview: p, contentType, seriesName, universeName, llm, committed, arcAlreadyPersisted } = state;
    if (!p) return;
    const issues = p.issueProposals || [];
    // A committed import needs no issues from this payload — it only resumes.
    if (!committed && issues.length === 0) { toast.error('No issues were extracted — retry the issue split or adjust the source'); return; }
    patch({ committing: true });
    // Skip commitImport when a prior click already committed (only the later
    // createStorySession failed) — re-running it would duplicate the
    // already-created issues and overwrite the arc. Resume at session creation.
    if (!committed) {
      // On an arcAlreadyPersisted retry the server kept arc/seasons/canon from
      // the failed commit, so resend issues only — re-sending the full payload
      // would clobber the persisted state and risk duplicate issues.
      const base = {
        universeId: p.universe.id,
        seriesId: p.series.id,
        // Server-side session: replays or resumes instead of duplicating (#9943).
        ...(p.importId ? { importId: p.importId } : {}),
        issues,
        contentType,
      };
      const payload = arcAlreadyPersisted
        ? { ...base, canonSelections: { characters: [], places: [], objects: [] }, arc: null, seasons: [] }
        : {
            ...base,
            canonSelections: {
              characters: p.canonPreview?.characters || [],
              places: p.canonPreview?.places || [],
              objects: p.canonPreview?.objects || [],
            },
            arc: pickArcFields(p.arcPreview),
            seasons: p.seasonsPreview || [],
          };
      const result = await commitImport(payload, { silent: true }).catch((err) => {
        if (err?.code === 'IMPORTER_PARTIAL_COMMIT_ISSUES' && err?.context?.arcAlreadyPersisted) {
          patch({ arcAlreadyPersisted: true });
          toast.warning('Arc + seasons saved; the issues did not finish. Click again to create the remaining issues without duplicating any — the arc won\'t be re-sent.');
          return null;
        }
        toast.error(err?.message || 'Import failed');
        return null;
      });
      if (!result) { patch({ committing: false }); return; }
      patch({ arcAlreadyPersisted: false, committed: true });
    }
    const session = await createStorySession({
      intakeMode: 'import',
      title: seriesName.trim() || universeName.trim(),
      // Seed from the extracted arc so the idea step has context and the
      // universe-aesthetic expand has a real starter (the imported universe
      // otherwise only has a name).
      seedIdea: (p.arcPreview?.summary || p.arcPreview?.logline || '').slice(0, 4000),
      universeId: p.universe.id,
      seriesId: p.series.id,
      // Persist the picker choice so every in-wizard operation uses it too.
      llm: { provider: llm.provider || null, model: llm.model || null },
    }, { silent: true }).catch((err) => { toast.error(err?.message || 'Failed to start the builder'); return null; });
    patch({ committing: false });
    if (session) onCreated(session);
  }, [state, patch, onCreated]);

  return { ...state, patch, analyze, retryIssues, importAndBuild };
}
