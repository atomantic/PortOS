import {
  AGY_IMAGEGEN_DEFAULT_MODEL,
  FAL_IMAGE_DEFAULT_MODEL, FAL_IMAGE_MODEL_IDS, FAL_IMAGE_MODEL_OPTIONS, falImageFamily,
  GOOGLE_IMAGE_DEFAULT_MODEL, GOOGLE_IMAGE_MODEL_IDS, GOOGLE_IMAGE_MODEL_OPTIONS, googleImageFamily,
  HIGGSFIELD_IMAGE_DEFAULT_MODEL, HIGGSFIELD_IMAGE_MODEL_IDS, HIGGSFIELD_IMAGE_MODEL_OPTIONS, higgsfieldImageFamily,
  IMAGE_GEN_MODE,
  RUNWAY_IMAGE_DEFAULT_MODEL, RUNWAY_IMAGE_MODEL_IDS,
} from '../../lib/imageGenBackends';

const CLOUD_MODEL_PICKERS = {
  [IMAGE_GEN_MODE.AGY]: {
    label: 'Agent model',
    defaultModel: AGY_IMAGEGEN_DEFAULT_MODEL,
  },
  [IMAGE_GEN_MODE.FAL]: {
    label: 'fal.ai model',
    defaultModel: FAL_IMAGE_DEFAULT_MODEL,
    ids: FAL_IMAGE_MODEL_IDS,
    options: FAL_IMAGE_MODEL_OPTIONS,
    family: falImageFamily,
  },
  [IMAGE_GEN_MODE.HIGGSFIELD]: {
    label: 'Higgsfield model',
    defaultModel: HIGGSFIELD_IMAGE_DEFAULT_MODEL,
    ids: HIGGSFIELD_IMAGE_MODEL_IDS,
    options: HIGGSFIELD_IMAGE_MODEL_OPTIONS,
    family: higgsfieldImageFamily,
  },
  [IMAGE_GEN_MODE.GOOGLE]: {
    label: 'Google model',
    defaultModel: GOOGLE_IMAGE_DEFAULT_MODEL,
    ids: GOOGLE_IMAGE_MODEL_IDS,
    options: GOOGLE_IMAGE_MODEL_OPTIONS,
    family: googleImageFamily,
  },
  [IMAGE_GEN_MODE.RUNWAY]: {
    label: 'Runway model',
    defaultModel: RUNWAY_IMAGE_DEFAULT_MODEL,
    ids: RUNWAY_IMAGE_MODEL_IDS,
    requiresLiveAvailability: true,
  },
};

export function resolveCloudModelPicker({
  mode, cloudModelsByMode, savedCloudModelsByMode, liveModelsByMode, setCloudModel,
}) {
  if (!Object.hasOwn(CLOUD_MODEL_PICKERS, mode)) {
    return { controlProps: {}, resolvedModel: null, unavailable: false };
  }

  const { label, defaultModel, ids, options, family, requiresLiveAvailability } = CLOUD_MODEL_PICKERS[mode];
  const models = options ?? liveModelsByMode[mode];
  const override = cloudModelsByMode[mode];
  const savedModel = savedCloudModelsByMode[mode] || defaultModel;
  // Runway keeps a catalog ID when availability changes so the picker can
  // explain the blocked selection and the user can choose a different model.
  const cloudModel = (ids ?? models).includes(override) ? override : '';
  const resolvedModel = cloudModel || savedModel;
  const unavailable = !!requiresLiveAvailability && !models.some((model) => model.id === resolvedModel);
  const cloudModels = unavailable && cloudModel
    ? [...models, { id: cloudModel, label: `${cloudModel} (unavailable)` }]
    : models;

  return {
    controlProps: {
      cloudModels,
      cloudModel,
      onCloudModelChange: (model) => setCloudModel(mode, model),
      cloudModelLabel: label,
      cloudModelDefaultLabel: family ? family(savedModel)?.label || defaultModel : savedModel,
    },
    resolvedModel,
    unavailable,
  };
}
