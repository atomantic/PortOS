# Unreleased Changes

## Changed

- **Elements Song study mode drops a redundant result field.** The Flash Cards study results tracked both `element` and `symbol` on each record even though they hold identical values; the review UI now reads the single `element` field, removing the duplicate.
