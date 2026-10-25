# Data Maintenance

Open **Settings → Data Maintenance** (also available through the command palette
and voice navigation) to inspect storage retained from retired features. Refresh
measures current files. A failed or unsafe inventory is unavailable, never shown
as zero bytes. The registry currently contains only LoRA retirement operations;
archive retention and whole-checkout cleanup are separate workflows.

LoRA training is retired. New training, dataset generation/captioning, resume and
media-queue retries are refused. Old training URLs lead to Data Maintenance.
Use the reference-image inputs supported by your chosen image model for new work.
PortOS does not convert a training dataset or checkpoint into a reference-image
workflow automatically, and the page offers no unsupported Upgrade action.

## Retained storage

- `data/lora-datasets`: unique source images, captions and dataset metadata.
- `data/training-runs`: mixed storage, including potentially unique optimizer
  checkpoints/adapters, training logs, caches and sample previews. Treat the
  category as unique data rather than assuming every checkpoint is reproducible.
- `data/loras`: installed adapters, including trained and imported adapters.
  These remain supported inference inputs. Use **Models → LoRAs** to manage them.
- Shared inference environments (mflux, MLX, torch/diffusers), media models and
  Hugging Face caches remain supported. Retirement does not uninstall them.

Saved training configuration and PostgreSQL history remain readable. No format
migration, boot purge or automatic configuration rewrite is required. A queued
trainer is retired without spawning; the run records the retirement. A verified
trainer that already survived a restart is observed to completion without starting
a new trainer. Its outputs are finalized normally. Automatic stall resumes are
disabled. Existing cancellation controls remain available in **Active Queues**.
An unowned detached trainer remains intact and blocks maintenance until it exits;
upgrade never kills it merely because the queue record is absent.

## Explicit removal

Copy unique files you want to keep and verify your own backup coverage first.
Backup settings, including the existing LoRA Time Machine exclusion, are unchanged.
The page is not a backup system.

1. Preview a supported removal. The server allowlist determines its exact category
   and path; callers cannot supply filesystem paths. The preview reports files,
   measured size and the consequence of removing that category.
2. Cancel to leave everything intact, or type the exact confirmation shown.
3. Confirm within five minutes. Changed inventory, symlinks, an unreadable tree,
   outstanding captioning, a surviving trainer or queued/running media work refuses
   removal. Refresh and preview again after resolving the reason.

Removal is permanent. There is no fake recovery/archive promise. A short admission
gate prevents media submissions racing the removal. The server serializes removals,
revalidates file identity, detaches the inspected directory and checks again before
removing it under backup publication admission. Duplicate submissions with the same
preview return the completed result while that preview remains valid. After a
server restart, a new preview is required.

On a filesystem failure, the UI reports an incomplete removal instead of success.
The error names the category and any detached `.maintenance-…` recovery directory;
inspect those locations before retrying. A partial filesystem failure can mean
some files were already removed. No automatic retry or boot cleanup purges the
remaining tree. PostgreSQL run history and installed inference adapters are never
removed by these operations.

## Extending the page

`server/services/dataMaintenance.js` owns the small operation registry. A new
operation must specify its fixed path, data category, preservation warning and
actual supported action. It must account for writers and shared consumers, reuse
fresh-preview/confirmation admission, and add a public-boundary synthetic fixture
regression. Do not add arbitrary paths, speculative migrations, shared-runtime
uninstallation or archive-cleanup operations to the registry.
