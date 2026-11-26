# Data Maintenance

Open **Models → LoRAs**. While `data/training-runs` or `data/lora-datasets` still
holds files, a **Retired training data** section lists each with its measured size.
A failed or unsafe inventory is unavailable, never shown as zero bytes. The
section does not render on an install with nothing left, or for a caller without
operator authority. The registry contains only LoRA retirement operations;
archive retention and whole-checkout cleanup are separate workflows.

LoRA training is retired. New training, dataset generation/captioning, resume and
media-queue retries are refused. Old training page URLs and `/settings/data-maintenance` lead to Models → LoRAs.
The legacy `/api/lora-training` routes have been removed.
Use the reference-image inputs supported by your chosen image model for new work.
PortOS does not convert a training dataset or checkpoint into a reference-image
workflow automatically, and the page offers no unsupported Upgrade action.

## Retained storage

- `data/lora-datasets`: unique source images, captions and dataset metadata.
- `data/training-runs`: mixed storage, including potentially unique optimizer
  checkpoints/adapters, training logs, caches and sample previews. Treat the
  category as unique data rather than assuming every checkpoint is reproducible.
- `data/loras`: installed adapters, including trained and imported adapters.
  These remain supported inference inputs. Manage them in the same **Models → LoRAs** page.
- Shared inference environments (mflux, MLX, torch/diffusers), media models and
  Hugging Face caches remain supported. Retirement does not uninstall them.

Upgrading keeps saved training configuration, PostgreSQL run history and files on
disk. Old queued or interrupted training entries close in the media queue. PortOS
continues to check for live legacy trainers before starting local accelerator
work or applying an automatic update. Data Manager labels an unfinished run
record with its last recorded status.
Manage installed adapters and remove retired data from the LoRAs page.

## Explicit removal

Copy unique files you want to keep and verify your own backup coverage first.
Backup settings, including the existing LoRA Time Machine exclusion, are unchanged.
The page is not a backup system.

1. Choose **Delete** on a retired row. An inline confirm names the exact path, its
   size and file count, and the consequence of removing that category. Cancel
   leaves everything intact.
2. Confirm. The client calls `DELETE /api/data-maintenance/:operationId`; the
   server allowlist determines the path (callers cannot supply one) and the call
   needs operator authority. Symlinks, unreadable files, a detached trainer from
   an older install or queued/running media work block removal.

Removal is permanent. There is no fake recovery/archive promise. A short admission
gate prevents media submissions racing the removal. The server serializes removals,
detaches the inspected directory, revalidates its identity and contents, and checks
again before removing it under backup publication admission. A second delete after
completion reports that nothing remains.

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
the serialized delete path, and add a public-boundary synthetic fixture
regression. Do not add arbitrary paths, speculative migrations, shared-runtime
uninstallation or archive-cleanup operations to the registry.
