import { screen, waitForElementToBeRemoved } from '@testing-library/react';

/**
 * Wait for a page's loading skeleton to be replaced by the loaded page.
 *
 * Two-sided ON PURPOSE. The natural way to write this barrier —
 * `waitFor(() => expect(screen.queryByText('Loading…')).not.toBeInTheDocument())`
 * — passes on its FIRST poll whenever the string it names is not on screen,
 * including when it was never rendered at all. `VideoTimelineEditor`'s test
 * helpers waited on `'Loading project…'`, which that page does not render, so
 * every test in both files ran against the skeleton whenever the mocked fetches
 * had not resolved yet: green on a fast machine, a different timing-sensitive
 * test red per CI run on a loaded one (#7448).
 *
 * `waitForElementToBeRemoved` throws when the element was not there to begin
 * with, so a label that stops matching fails loudly instead of silently
 * becoming a no-op. Pass the `label` a page hands its `PageSkeleton`, which is
 * the skeleton's accessible name.
 *
 * @param {string} label the PageSkeleton `label` prop, e.g. 'Loading timeline project'
 */
export const awaitPageLoaded = (label) => waitForElementToBeRemoved(screen.getByLabelText(label));
