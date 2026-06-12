# Next Release

## Changed

- **[issue-1214] Staged upload images no longer pile up on disk** — init and reference images you upload for edit/image-to-image renders are now cleaned up automatically once they're a week old and no longer used by any saved image, so repeated edit-from-upload renders stop quietly growing your data folder.
