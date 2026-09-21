# Runtimes operations pilot

Scope: #7795, part of #7791. Uses the operations page family in the UX design guide.

## Task and content map

| Task | Before | After |
| --- | --- | --- |
| Inspect and operate servers | Runtime rows mix lifecycle, startup and residency controls; backend and setup cards follow | Aligned identity/state/action columns when the container fits; contextual Start/Stop/Install/Configure, with startup and residency disclosures |
| Configure a runtime | Configure scrolls to one of several long inline launchers | Configure selects a runtime URL; spacious containers show roster and configuration together, narrower containers show the selected detail with All runtimes recovery |
| Inspect downloads and return to work | Progress lives in the long runtime sections | Existing progress owners remain mounted; active transfers have visible links back to their cancellation controls |
| Consult setup guidance | Setup and recommendations precede backend/launcher configuration | A named disclosure follows the operational workspace; speculative-decoding explanation is also optional |

The base Runtimes navigation entry, icons, aliases and management URLs remain unchanged. Selection uses existing runtime IDs. A selected detail is navigation only; installation, downloads, saves and lifecycle actions still require their existing explicit actions. The dedicated Qwen host keeps its existing setup/usage destination.

## Evidence and limits

Rendered interaction tests cover opening configuration, invalid-selection recovery, selected Models navigation, launch-draft retention through selection and browser history, returning to download cancellation, and subscriber counts. Existing lifecycle, failure, save, installation and download tests continue to exercise their public controls. Unread status has a distinct state and does not advertise installation.

A temporary isolated browser harness rendered the actual components with synthetic status responses and a disabled socket connection. No live instance records or providers were used. Visual checks covered 320px, approximately 390px, 1,024px, 1,440px and 1,920px CSS widths, with Classic dark and light palettes sampled. The full application navigation was covered by existing Models tests, not reproduced by the isolated harness.

Observed: desktop roster columns align; large selected workspaces place configuration beside the roster; narrow selection hides the roster while retaining a return link; long synthetic identifiers wrap; the inspected viewport widths had no horizontal document overflow. Selecting Configure moves focus to the detail heading. Returning restores focus to the selected runtime's Configure control. A 320px inspection exposed an overly narrow launch-blocker message beside Start; wrapping that action group keeps the message readable.

These are synthetic task-path and layout checks, not a timed user study or hardware validation. No claims are made about faster task completion, download throughput, or runtime behavior on specific hardware. The lifecycle implementation and provider-consent semantics are unchanged.
