"""Audit every Pixal3D CUDA registry identity and immutable native/source revision."""
import importlib.util
from pathlib import Path
import sys

spec = importlib.util.spec_from_file_location('cuda_audit', Path(__file__).with_name('audit-trellis2-cuda.py'))
audit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit)


def main():
    return audit.main('pixal3d-cuda-profile.json',
        ['requirements-pixal3d-cuda.lock.txt', 'requirements-pixal3d-cuda-build.lock.txt'],
        [('natten', '0.21.0'), ('moge', '2.0.0'), ('pipeline', '1.0.0')])


if __name__ == '__main__':
    sys.exit(main())
