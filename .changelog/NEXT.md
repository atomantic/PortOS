## Added

- Time Capsule Snapshots for Digital Twin — create versioned archives of your complete digital twin (documents, traits, goals, genome, autobiography, test history) to track identity evolution over time. Includes create, view, compare, and delete functionality with a dedicated tab at `/digital-twin/time-capsule`

## Changed

- Goals page: replace "Add Root Goal" button with inline quick-add input for faster goal creation
- Goals page: remove manual refresh button, use Loader2 spinner for loading state

## Fixed

- Toggle switches rendering oversized due to min-h/min-w 44px touch-target constraints inflating the visual element
- Brain scheduler CLI error messages now include actual CLI output for diagnosability
- Brain CLI provider stdin warning by closing stdin on spawn
- Brain default model/provider in data.sample for new users
