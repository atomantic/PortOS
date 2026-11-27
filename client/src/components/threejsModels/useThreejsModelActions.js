import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import useProviderModels from '../../hooks/useProviderModels';
import useThreejsModelFamilies, { GENERAL_FAMILY_ID, resolveFamilyId } from '../../hooks/useThreejsModelFamilies';
import { deleteThreejsModel, generateThreejsModel, getThreejsModelSource } from '../../services/apiThreejsModels.js';
import toast from '../ui/Toast';
import { copyToClipboard } from '../../lib/clipboard';
import { seedModelEffort } from '../../utils/providers';

const providerFilter = (provider) =>
  provider.enabled !== false && ['api', 'cli', 'tui'].includes(provider.type);


export default function useThreejsModelActions({ id, record, setRecord, refetch }) {
  const navigate = useNavigate();
  const [feedback, setFeedback] = useState('');
  const [starting, setStarting] = useState(false);
  const [effort, setEffort] = useState('');
  const { families, status: familiesStatus, retry: retryFamilies } = useThreejsModelFamilies();
  const [family, setFamily] = useState(GENERAL_FAMILY_ID);
  const [referenceImages, setReferenceImages] = useState([]);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [, setSearchParams] = useSearchParams();
  // Bumped on every "Show in preview" so the same moment can be requested again
  // after the viewer scrubbed away from it; the URL alone would not change.
  const [seekToken, setSeekToken] = useState(0);
  const previewRef = useRef(null);
  const providerSyncRef = useRef('');
  const {
    providers,
    selectedProviderId,
    selectedModel,
    availableModels,
    setSelectedProviderId,
    setSelectedModel,
    loading: providersLoading,
    // This picker renders the effort control and threads the value to the
    // server, so Antigravity lists base models with effort picked separately.
  } = useProviderModels({ filter: providerFilter, silent: true, withEffort: true });

  useEffect(() => {
    if (!record || providers.length === 0) return;
    const key = `${record.id}:${record.providerId}:${record.model || ''}:${record.effort || ''}`;
    if (providerSyncRef.current === key) return;
    const recordProvider = providers.find((provider) => provider.id === record.providerId);
    if (recordProvider) {
      // A record written before Antigravity split model from effort stores the
      // suffixed id (`gemini-3.6-flash-high`); seedModelEffort reads it back as
      // a base model + its effort so the pin isn't an option that no longer
      // exists (and leaves every other provider's id untouched).
      const seeded = seedModelEffort(recordProvider, record.model, record.effort);
      setSelectedProviderId(record.providerId);
      setSelectedModel(seeded.model);
      setEffort(seeded.effort);
    }
    providerSyncRef.current = key;
  }, [record, providers, setSelectedProviderId, setSelectedModel]);

  // Kept out of the provider-sync effect above: the family belongs to the record,
  // not to the provider, so a record whose provider is gone (or an install with
  // none configured) must still read its stored family back into the picker.
  // Re-seeds per record id only, so a user's in-form change survives the
  // model events while a generation is running.
  useEffect(() => {
    setFamily(record?.family || GENERAL_FAMILY_ID);
  }, [record?.id]);

  useEffect(() => {
    setReferenceImages(record?.referenceImages || []);
  }, [record?.id]);

  const handleGenerate = async () => {
    if (!selectedProviderId || record?.status === 'generating') return;
    setStarting(true);
    const next = await generateThreejsModel(id, {
      providerId: selectedProviderId,
      model: selectedModel || undefined,
      // Always sent (as `''` when unset) so picking "Default effort" CLEARS the
      // record's stored override instead of silently re-applying it.
      effort,
      // Always sent so switching back to General turns the checklist OFF for
      // this pass instead of silently re-applying the record's stored family.
      // Resolved against the served taxonomy so what is sent is what the picker
      // is showing, even for a record holding a family this install dropped.
      family: resolveFamilyId(families, family),
      // Always sent so removing every view clears them instead of keeping the stored set.
      referenceImages,
      prompt: record.prompt || '',
      feedback: feedback.trim(),
    }, { silent: true }).catch((error) => {
      toast.error(error.message || 'Failed to start generation');
      return null;
    });
    setStarting(false);
    if (next) {
      setRecord(next);
      refetch();
      setFeedback('');
      toast.success(record.spec ? 'Refinement started' : 'Generation started');
    }
  };

  // The clip, the moment and the two parts all go in the URL, so what the viewer
  // is looking at survives a reload and can be shared.
  const handleShowFinding = (finding) => {
    setSearchParams((previous) => {
      const next = new URLSearchParams(previous);
      next.set('clip', finding.clipId);
      next.set('time', String(finding.timeSeconds));
      next.set('highlight', finding.partIds.join(','));
      return next;
    }, { replace: true });
    setSeekToken((token) => token + 1);
    previewRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  };

  const handleCopySource = async () => {
    const source = await getThreejsModelSource(id, { silent: true }).catch((error) => {
      toast.error(error.message || 'Failed to load source');
      return null;
    });
    if (source) await copyToClipboard(source, 'Three.js source copied');
  };

  const handleDelete = async () => {
    const ok = await deleteThreejsModel(id, { silent: true }).then(() => true).catch((error) => {
      toast.error(error.message || 'Delete failed');
      return false;
    });
    if (ok) navigate('/3d/threejs');
  };

  return {
    families, familiesStatus, retryFamilies, family, setFamily, referenceImages, setReferenceImages,
    confirmingDelete, setConfirmingDelete, seekToken, previewRef, providers, selectedProviderId,
    selectedModel, availableModels, setSelectedProviderId, setSelectedModel, providersLoading,
    effort, setEffort, starting, feedback, setFeedback, handleGenerate, handleShowFinding,
    handleCopySource, handleDelete,
  };
}
