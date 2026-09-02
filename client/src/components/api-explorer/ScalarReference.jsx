// @scalar/api-reference-react is the heaviest dependency in the client, by a wide
// margin: 261 of the client's 599 installed packages (44%) are reachable ONLY through
// it, and its dist assets weigh 3.24 MB against ~13.0 MB of built JS in total (25%). That
// includes an entire second UI framework (Vue 3 + radix-vue + @headlessui/vue) and the
// Vercel AI SDK, pulled in as a hard dependency via @scalar/agent-chat.
//
// `agent: { disabled: true }` below is a RUNTIME config value, not a build-time flag —
// Rollup cannot tree-shake on it, so the agent chat interface is still emitted as its
// own chunk. Turning it off changes the UI, not the bundle.
//
// The footprint is bounded by client/src/pages/ApiExplorer.bundle.test.js (a 4.0 MB
// budget over the Scalar-attributable dist chunks, run in CI right after the client
// build). Read that test and the `@scalar/api-reference-react` entry in docs/DEPS.md
// before bumping this dependency.
import { useMemo } from 'react';
import { ApiReferenceReact } from '@scalar/api-reference-react';
import '@scalar/api-reference-react/style.css';
import '../../pages/ApiExplorer.css';

export default function ScalarReference({ url }) {
  const configuration = useMemo(() => ({
    url,
    agent: { disabled: true },
    hideClientButton: true,
    hideTestRequestButton: true,
    showDeveloperTools: 'never',
    theme: 'purple',
    layout: 'modern',
    operationTitleSource: 'summary',
  }), [url]);

  return <ApiReferenceReact configuration={configuration} />;
}
