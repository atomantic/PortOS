# Digital Twin

Open **Digital Twin** to capture identity and calibrate how a model represents different contexts. Start with Overview and Identity, then add documents, autobiography, values, taste or goals as needed. In Documents, manage soul Markdown such as `SOUL.md` and `VALUES.md`. Use Interview and Enrich to collect more context, then review the resulting documents before exporting them.

## Calibrate and test

- **Personality** shows trait scores and confidence. Low confidence and gap recommendations identify where to add observations or feedback. Review the underlying evidence before changing trait weights.
- **Personas** adds named context-specific adjustments to the base profile. Only one is active at a time. Use persona-specific test runs before adopting a profile.
- **Test** covers behavioral, multi-turn, values-alignment and adversarial-boundary suites. The run history records the selected persona and grader verdict. Compare runs with their persona and model in view.
- Paste a transcript for interview analysis or compare spoken and written samples for qualitative style guidance. Upload an image deliberately when using image identity analysis.

## Bring in your data

The Import tab accepts Goodreads CSV, Spotify extended history, Letterboxd exports and iCal files. Review the analysis before saving it. The Spotify browser workflow uses the managed browser's existing sign-in and opens Spotify's Account Privacy page. If the package is pending or needs confirmation, retry when available, or upload the Spotify JSON manually. Completed downloaded files are cleaned from the browser cache after processing.

## Use taste in a Music Creative Commission

In the commission editor, opt into the Digital Twin source, set the observation window, anchor count and exploration level, and choose an installed renderer. The scheduled job uses bounded anchors and records the renderer and recipe in run history. If the source has no usable anchors or the renderer is unavailable, the job records a skip. Raw listening history and detailed recipe provenance stay local. Use **more familiar**, **more experimental**, **keep anchors** or **change anchors** feedback to steer later runs.

See [Privacy Center](./privacy-center.md) for local data controls and [API Explorer](../API.md) for live endpoints.
