"""Run with the lane's private Python after setup and a synthetic-image render."""
import argparse
import importlib
import importlib.metadata
import json
import sys

import numpy as np
import torch
import trimesh


def bare_list_annotation():
    value: list = [1, 2, 3]
    return value


def bare_tuple_annotation():
    value: tuple = (1, 2)
    return value


def typed_list_annotation():
    value: list[int] = [1, 2, 3]
    return value


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mesh', help='GLB produced from a synthetic or licensed input')
    args = parser.parse_args()
    assert sys.version_info[:2] == (3, 13)
    assert torch.__version__.split('+')[0] == '2.15.0'
    assert torch.backends.mps.is_available()
    for module in ('torchvision', 'moge', 'cumesh', 'flex_gemm', 'mtlbvh',
                   'mtldiffrast', 'o_voxel', 'natten', 'natten_mps'):
        importlib.import_module(module)

    # Harmless upstream b90c949 regression: reject bare containers while a
    # properly typed function still compiles. Never compile input/model text.
    for function, container in ((bare_list_annotation, 'list'), (bare_tuple_annotation, 'tuple')):
        try:
            torch.jit.script(function)
        except RuntimeError as error:
            assert f'Attempted to use {container} without a contained type' in str(error)
        else:
            raise AssertionError(f'JIT accepted bare {container} annotation')
    assert torch.jit.script(typed_list_annotation)() == [1, 2, 3]

    scene = trimesh.load(args.mesh, force='scene')
    assert scene.geometry, 'No output geometry'
    vertices = faces = 0
    for mesh in scene.geometry.values():
        assert len(mesh.vertices) > 0 and len(mesh.faces) > 0
        assert np.isfinite(mesh.vertices).all()
        assert np.isfinite(mesh.bounds).all()
        assert mesh.faces.min() >= 0 and mesh.faces.max() < len(mesh.vertices)
        assert (mesh.area_faces > 0).any(), 'All triangles are degenerate'
        vertices += len(mesh.vertices)
        faces += len(mesh.faces)
    print(json.dumps({'ok': True, 'python': sys.version.split()[0],
                      'torch': torch.__version__,
                      'torchvision': importlib.metadata.version('torchvision'),
                      'jit_regression': 'passed', 'vertices': vertices, 'faces': faces}))


if __name__ == '__main__':
    main()
