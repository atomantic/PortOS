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
