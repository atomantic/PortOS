import { useState } from 'react';
import toast from '../ui/Toast';
import { openCatalogPhotorealBlend } from '../../services/apiCatalog';

export default function usePhotorealBlender(ingredientId, engine, acceptOpened) {
  const [opening, setOpening] = useState(false);
  const [blenderExecution, setBlenderExecution] = useState(null);
  const [blenderRefresh, setBlenderRefresh] = useState(0);
  const [blenderRefreshing, setBlenderRefreshing] = useState(false);
  const [blenderOpenRequest, setBlenderOpenRequest] = useState(0);
  const [blenderNotice, setBlenderNotice] = useState('');
  const [sceneBuildError, setSceneBuildError] = useState('');
  const blenderReady = blenderExecution?.lanes?.blender?.ready === true;
  const checkedEngine = blenderExecution?.tools?.blender?.engine;
  const requestedEngine = engine === 'eevee' ? 'BLENDER_EEVEE_NEXT' : 'CYCLES';
  // Contained Blender has no GPU, so the server refuses EEVEE there; say so before the click.
  const noGpuNotice = engine === 'eevee' && blenderExecution?.executionMode === 'contained' ? blenderExecution.containedGpuNotice : null;
  const openSetup = () => setBlenderOpenRequest(value => value + 1);
  const handleBlenderError = (err, fallback) => {
    if (err?.code === 'CODE_ANIMATION_BLENDER_NOT_READY') {
      setBlenderNotice(`Blender setup changed before this action started. Check the setup, then try again.${err.message ? ` ${err.message}` : ''}`);
      setBlenderExecution(null);
      setBlenderRefreshing(true);
      setBlenderRefresh((value) => value + 1);
    } else toast.error(err?.message || fallback);
  };

  const openInBlender = async () => {
    setBlenderNotice('');
    setSceneBuildError('');
    setOpening(true);
    const opened = await openCatalogPhotorealBlend(ingredientId, { silent: true })
      .catch((err) => {
        if (err?.code === 'PHOTOREAL_BUILD_FAILED') setSceneBuildError(err.message || 'Could not build the Blender scene.');
        else handleBlenderError(err, 'Could not open Blender');
        return null;
      });
    setOpening(false);
    if (opened) {
      acceptOpened(opened);
      toast.success('Opened in Blender. The next render replaces this scene, so use File › Save As to keep your changes.');
    }
  };

  const onExecutionChange = (next) => {
    setBlenderExecution(next);
    if (next) setBlenderRefreshing(false);
  };

  return {
    clearNotice: () => setBlenderNotice(''),
    opening, openInBlender, openSetup, handleBlenderError, blenderReady, checkedEngine, noGpuNotice,
    engineReady: blenderReady && !noGpuNotice,
    engineMismatch: checkedEngine && checkedEngine !== requestedEngine,
    platform: blenderExecution?.platform,
    setup: {
      onExecutionChange,
      refreshKey: blenderRefresh,
      openRequest: blenderOpenRequest,
      refreshing: blenderRefreshing,
      notice: blenderNotice,
      sceneBuildError,
    },
  };
}
