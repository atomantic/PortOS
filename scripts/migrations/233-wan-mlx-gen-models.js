/**
 * Replace the failed Wan2.2-mlx catalog rows with pinned MLX-Gen q8 profiles,
 * and add TI2V-5B plus validated A14B Lightning profiles to existing installs.
 * Runtime/packages/weights are still installed only from the Video Gen UI.
 */

import { readFile } from 'fs/promises';
import { join } from 'path';
import { atomicWrite } from '../../server/lib/fileUtils.js';
import { VIDEO_BUCKET_MLX, readVideoBucket } from '../../server/lib/mediaModelBuckets.js';

const REL_PATH = 'data/media-models.json';
const LIGHTNING_REPO = 'lightx2v/Wan2.2-Lightning';
const LIGHTNING_REVISION = '18bccf8884ec0a078eed79785eb4ef13ea16ce1e';
const TI2V_REVISION = '6875952a110b6bdbcfc00d72b1d89a8e02ab0fc3';
const T2V_REVISION = '39ee5f1f630789956f29f40b5c2c6d48c6e9a798';
const I2V_REVISION = '1a17fbea2649c576de844e08e79fe56296751efa';
const USER_TUNABLE_FIELDS = ['name', 'steps', 'guidance', 'guidance2', 'flowShift', 'solver', 'memoryGb'];

const NEW_ENTRIES = [
  {
    id: 'wan22_ti2v_5b', name: 'Wan 2.2 TI2V 5B Q8 (~17 GiB download, text + image)',
    repo: 'AbstractFramework/wan2.2-ti2v-5b-diffusers-8bit', revision: TI2V_REVISION, runtime: 'wan22',
    supportedModes: ['text', 'image'], frameStride: 4, fpsOptions: [16, 20, 24],
    memoryGb: 24, steps: 25, guidance: 5, flowShift: 3, solver: 'unipc',
  },
  {
    id: 'wan22_t2v_a14b_lightning', name: 'Wan 2.2 T2V A14B Lightning Q8 (~40 GiB download, 64+ GB RAM, 4-step)',
    repo: 'AbstractFramework/wan2.2-t2v-a14b-diffusers-8bit', revision: T2V_REVISION, runtime: 'wan22',
    supportedModes: ['text'], frameStride: 4, fpsOptions: [16, 20, 24], memoryGb: 48,
    steps: 4, guidance: 1, guidance2: 1, flowShift: 5, solver: 'euler', samplerLocked: true,
    requiredWeights: [{
      repo: LIGHTNING_REPO, revision: LIGHTNING_REVISION,
      files: [
        'Wan2.2-T2V-A14B-4steps-lora-rank64-Seko-V1.1/high_noise_model.safetensors',
        'Wan2.2-T2V-A14B-4steps-lora-rank64-Seko-V1.1/low_noise_model.safetensors',
      ],
      targetRoles: ['high_noise_transformer', 'low_noise_transformer'],
    }],
  },
  {
    id: 'wan22_i2v_a14b_lightning', name: 'Wan 2.2 I2V A14B Lightning Q8 (~40 GiB download, 64+ GB RAM, 4-step)',
    repo: 'AbstractFramework/wan2.2-i2v-a14b-diffusers-8bit', revision: I2V_REVISION, runtime: 'wan22',
    supportedModes: ['image'], frameStride: 4, fpsOptions: [16, 20, 24], memoryGb: 48,
    steps: 4, guidance: 1, guidance2: 1, flowShift: 5, solver: 'euler', samplerLocked: true,
    requiredWeights: [{
      repo: LIGHTNING_REPO, revision: LIGHTNING_REVISION,
      files: [
        'Wan2.2-I2V-A14B-4steps-lora-rank64-Seko-V1/high_noise_model.safetensors',
        'Wan2.2-I2V-A14B-4steps-lora-rank64-Seko-V1/low_noise_model.safetensors',
      ],
      targetRoles: ['high_noise_transformer', 'low_noise_transformer'],
    }],
  },
];

const UPGRADES = {
  wan22_t2v_a14b: {
    oldRepo: 'Wan-AI/Wan2.2-T2V-A14B',
    oldName: 'Wan 2.2 T2V A14B (~28 GB, MoE-14B-active)',
    next: {
      name: 'Wan 2.2 T2V A14B Q8 (~40 GiB download, 64+ GB RAM)',
      repo: 'AbstractFramework/wan2.2-t2v-a14b-diffusers-8bit',
      revision: T2V_REVISION,
      runtime: 'wan22', supportedModes: ['text'], frameStride: 4,
      fpsOptions: [16, 20, 24], memoryGb: 48, steps: 20, guidance: 4,
      guidance2: 3, flowShift: 3, solver: 'unipc',
    },
  },
  wan22_i2v_a14b: {
    oldRepo: 'Wan-AI/Wan2.2-I2V-A14B',
    oldName: 'Wan 2.2 I2V A14B (~28 GB, image-to-video)',
    next: {
      name: 'Wan 2.2 I2V A14B Q8 (~40 GiB download, 64+ GB RAM)',
      repo: 'AbstractFramework/wan2.2-i2v-a14b-diffusers-8bit',
      revision: I2V_REVISION,
      runtime: 'wan22', supportedModes: ['image'], frameStride: 4,
      fpsOptions: [16, 20, 24], memoryGb: 48, steps: 20, guidance: 3.5,
      guidance2: 3.5, flowShift: 3, solver: 'unipc',
    },
  },
};

export default {
  async up({ rootDir }) {
    const path = join(rootDir, REL_PATH);
    const raw = await readFile(path, 'utf-8').catch((err) => {
      if (err.code === 'ENOENT') return null;
      throw err;
    });
    if (raw == null) return;
    let config;
    try {
      config = JSON.parse(raw);
    } catch (err) {
      throw new Error(`Cannot migrate ${REL_PATH}: invalid JSON (${err.message})`, { cause: err });
    }
    // Bucket key resolved canonical-first with a legacy fallback: this
    // migration predates the #4142 `macos` → `mlx` rename, so it meets either.
    const mlxEntries = readVideoBucket(config?.video, VIDEO_BUCKET_MLX);
    if (!Array.isArray(mlxEntries)) return;

    let changed = false;
    for (const entry of mlxEntries) {
      const spec = UPGRADES[entry?.id];
      if (!spec || entry.repo !== spec.oldRepo) continue;
      const preserved = Object.fromEntries(USER_TUNABLE_FIELDS
        .filter((field) => Object.prototype.hasOwnProperty.call(entry, field))
        .map((field) => [field, entry[field]]));
      if (entry.name === spec.oldName) delete preserved.name;
      if (entry.steps === 25) delete preserved.steps;
      if (entry.guidance === 5) delete preserved.guidance;
      Object.assign(entry, spec.next);
      Object.assign(entry, preserved);
      if (entry.mode === 't2v' || entry.mode === 'i2v') delete entry.mode;
      changed = true;
    }

    const present = new Set(mlxEntries.map((entry) => entry?.id));
    for (const entry of NEW_ENTRIES) {
      if (present.has(entry.id)) continue;
      mlxEntries.push(entry);
      present.add(entry.id);
      changed = true;
    }
    const shipped = readVideoBucket(config?._shippedDefaults?.video, VIDEO_BUCKET_MLX);
    if (Array.isArray(shipped)) {
      for (const entry of NEW_ENTRIES) {
        if (!shipped.includes(entry.id)) { shipped.push(entry.id); changed = true; }
      }
    }
    if (changed) {
      await atomicWrite(path, `${JSON.stringify(config, null, 2)}\n`);
      console.log(`📝 ${REL_PATH}: upgraded Wan 2.2 to MLX-Gen and added TI2V/Lightning profiles`);
    }
  },
};
