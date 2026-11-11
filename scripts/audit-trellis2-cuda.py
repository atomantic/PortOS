"""Query OSV (including MAL records) for every locked CUDA registry/source input."""
import json
from pathlib import Path
import re
import sys
from urllib.request import Request, urlopen

SCRIPTS = Path(__file__).resolve().parent


def main():
    profile = json.loads((SCRIPTS / 'trellis2-cuda-profile.json').read_text())
    pins = set()
    for lock in ['requirements-trellis2-cuda.lock.txt', 'requirements-trellis2-cuda-build.lock.txt']:
        pins.update(re.findall(r'^([\w.-]+)==([^\s;\\]+)', (SCRIPTS / lock).read_text(), re.M))
    # CUDA-flavored Torch wheels are direct URLs; query the upstream package version too.
    pins.update({('torch', profile['torch'].split('+')[0]), ('torchvision', profile['torchvision'].split('+')[0]),
                 ('flash-attn', profile['flashAttention']), ('utils3d', '0.0.2'), ('nvdiffrast', '0.4.0'),
                 ('nvdiffrec-render', '0.0.0'), ('cumesh', '0.0.1'), ('flex-gemm', '1.0.0'), ('o-voxel', '0.0.1')})
    queries = [{'package': {'ecosystem': 'PyPI', 'name': name}, 'version': version} for name, version in sorted(pins)]
    for item in profile['condaArtifacts']:
        queries.append({'package': {'purl': 'pkg:conda/conda-forge/' + item['name'] + '@' + item['version']
                                   + '?build=' + item['build'] + '&subdir=' + item['url'].split('/')[-2]}})
    queries.append({'package': {'purl': 'pkg:conda/conda-forge/micromamba@2.3.2?build=0&subdir=linux-64'}})
    queries.extend({'commit': source['revision']} for source in profile['sources'])
    data = json.dumps({'queries': queries}).encode()
    with urlopen(Request('https://api.osv.dev/v1/querybatch', data, {'Content-Type': 'application/json'}), timeout=120) as response:
        results = json.load(response)['results']
    if len(results) != len(queries) or any('error' in result for result in results):
        raise SystemExit('OSV returned incomplete/error results; audit remains unresolved.')
    findings = [{'query': query, 'ids': [v['id'] for v in result.get('vulns', [])]}
                for query, result in zip(queries, results) if result.get('vulns')]
    print(json.dumps({'queries': len(queries), 'pypiIdentities': len(pins),
                      'condaArtifacts': len(profile['condaArtifacts']) + 1,
                      'sourceRevisions': len(profile['sources']), 'findings': findings}, indent=2))
    # OSV's Conda coverage is limited; no matches do not establish complete native advisory coverage.
    return 1 if findings else 0


if __name__ == '__main__':
    sys.exit(main())
