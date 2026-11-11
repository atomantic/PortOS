"""Query every rigging registry identity through OSV, including MAL records."""
import json
from pathlib import Path
import re
import sys
from urllib.request import Request, urlopen

SCRIPTS = Path(__file__).resolve().parent


def main():
    profile = json.loads((SCRIPTS / 'rigging-profile.json').read_text())
    pins = set()
    artifacts = {}
    for target in profile['profiles'].values():
        pins.update(re.findall(r'^([\w.-]+)==([^\s;\\]+)', (SCRIPTS / target['requirements']).read_text(), re.M))
        for artifact in target['condaArtifacts']:
            artifacts[artifact['url']] = artifact
            if artifact['name'] == 'pip':
                pins.add(('pip', artifact['version']))
    queries = [{'package': {'ecosystem': 'PyPI', 'name': name}, 'version': version} for name, version in sorted(pins)]
    for artifact in artifacts.values():
        queries.append({'package': {'purl': 'pkg:conda/conda-forge/' + artifact['name'] + '@' + artifact['version']
                                   + '?build=' + artifact['build'] + '&subdir=' + artifact['url'].split('/')[-2]}})
    request = Request('https://api.osv.dev/v1/querybatch', json.dumps({'queries': queries}).encode(),
                      {'Content-Type': 'application/json'})
    with urlopen(request, timeout=120) as response:
        results = json.load(response)['results']
    if len(results) != len(queries) or any('error' in result for result in results):
        raise SystemExit('OSV returned incomplete/error results; audit remains unresolved.')
    findings = []
    for query, result in zip(queries, results):
        ids = set()
        pages = set()
        while True:
            if not isinstance(result, dict) or 'error' in result:
                raise SystemExit('OSV returned an error page; audit remains unresolved.')
            ids.update(v['id'] for v in result.get('vulns', []))
            token = result.get('next_page_token')
            if not token:
                break
            if not isinstance(token, str) or token in pages:
                raise SystemExit('OSV returned invalid/repeated pagination; audit remains unresolved.')
            pages.add(token)
            request = Request('https://api.osv.dev/v1/query',
                              json.dumps({**query, 'page_token': token}).encode(),
                              {'Content-Type': 'application/json'})
            with urlopen(request, timeout=120) as response:
                result = json.load(response)
        if ids:
            findings.append({'query': query, 'ids': sorted(ids)})
    print(json.dumps({'queries': len(queries), 'pypiIdentities': len(pins),
                      'condaArtifacts': len(artifacts), 'findings': findings}, indent=2))
    # OSV Conda coverage is limited; empty PURL results do not certify native libraries.
    return 1 if findings else 0


if __name__ == '__main__':
    sys.exit(main())
