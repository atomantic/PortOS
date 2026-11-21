"""Install/Repair Pixal3D with a separate, locked native Linux CUDA environment."""
import argparse
import importlib.util
import json
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('trellis_cuda', SCRIPTS / 'setup-trellis2-cuda.py')
cuda = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cuda)


def replace_once(text, before, after):
    if text.count(before) != 1:
        raise SystemExit('The pinned Pixal3D native/runtime interface changed: ' + before[:80])
    return text.replace(before, after)


def patch_runtime(source, profile):
    cuda.patch_runtime(source, profile)
    feature = source / 'Pixal3D/pixal3d/trainers/flow_matching/mixins/image_conditioned_proj.py'
    text = replace_once(feature.read_text(), 'self.model.layer', profile['runtimePatches']['dinov3EncoderLayers'])
    text = replace_once(text, '            import torch.hub', '''            import importlib.util
            if importlib.util.find_spec("natten") is None:
                return
            import torch.hub''')
    text = replace_once(text,
        '"valeoai/NAF", "naf", pretrained=True, device=device, trust_repo=True',
        repr(str(source / 'deps/NAF')) + ', "naf", pretrained=True, device=device, source="local"')
    text = replace_once(text, '''                hr_features = self.naf_model(
                    image_for_naf, lr_features_bchw, self.naf_target_size
                )''', '''                hr_features = (
                    self.naf_model(image_for_naf, lr_features_bchw, self.naf_target_size)
                    if self.naf_model is not None else
                    F.interpolate(lr_features_bchw, size=self.naf_target_size,
                                  mode="bilinear", align_corners=False)
                )''')
    feature.write_text(text)
    # MoGe's Git dependencies are supplied by the verified wheel/source closure.
    # Keep its package metadata consistent with the installed local distributions.
    metadata = source / 'deps/MoGe/pyproject.toml'
    text = metadata.read_text()
    text = replace_once(text, 'utils3d @ git+https://github.com/EasternJournalist/utils3d.git@3fab839f0be9931dac7c8488eb0e1600c236e183', 'utils3d==0.0.2')
    text = replace_once(text, 'pipeline @ git+https://github.com/EasternJournalist/pipeline.git@866f059d2a05cde05e4a52211ec5051fd5f276d6', 'pipeline==1.0.0')
    # The web demo is not part of this CLI lane. Headless OpenCV supplies cv2
    # without installing two distributions that own the same package files.
    text = replace_once(text, '    "gradio",\n', '')
    text = replace_once(text, '"opencv-python"', '"opencv-python-headless"')
    metadata.write_text(text)


def patch_build(directory, package, profile):
    cuda.patch_build(directory, package, profile)
    if package == 'natten':
        cmake = directory / 'csrc/CMakeLists.txt'
        text = replace_once(cmake.read_text(), 'set(CXX_STD "17"', 'set(CXX_STD "20"')
        cmake.write_text(text.replace('-std=c++17', '-std=c++20'))


VERIFY = cuda.VERIFY.replace(
    "# Imported setuptools", """
import importlib.util, os, sys
sys.path.insert(0, os.path.join(os.environ['PYTHONPATH'], 'Pixal3D'))
from pixal3d.pipelines import Pixal3DImageTo3DPipeline
from moge.model.v2 import MoGeModel
from pixal3d.trainers.flow_matching.mixins.image_conditioned_proj import DinoV3ProjFeatureExtractor
extractor = DinoV3ProjFeatureExtractor.__new__(DinoV3ProjFeatureExtractor)
torch.nn.Module.__init__(extractor)
extractor.model = DINOv3ViTModel(DINOv3ViTConfig(hidden_size=32, intermediate_size=64,
    num_hidden_layers=1, num_attention_heads=4, image_size=32, patch_size=16, num_register_tokens=4)).eval()
features = extractor.extract_features(torch.randn(1, 3, 32, 32))
assert features.shape == (1, 9, 32) and torch.isfinite(features).all()
if importlib.util.find_spec('natten') is not None:
    import natten
    from natten.functional import na2d
    q = torch.randn(1, 9, 9, 2, 32, device='cuda', dtype=torch.float16)
    assert torch.isfinite(na2d(q, q, q, kernel_size=3)).all()
    naf = torch.hub.load(os.path.join(os.environ['PYTHONPATH'], 'deps/NAF'),
                         'naf', source='local', pretrained=False, device='cuda').eval()
    with torch.no_grad():
        result = naf(torch.randn(1, 3, 32, 32, device='cuda'),
                     torch.randn(1, 32, 9, 9, device='cuda'), (18, 18))
    assert result.shape == (1, 32, 18, 18) and torch.isfinite(result).all()
else:
    extractor.naf_model = None
    extractor._load_naf()
    assert extractor.naf_model is None
    print('[setup] NATTEN unavailable: NAF uses interpolated DINO features (lower detail).')
# Imported setuptools"""
)


def install(root, cuda_home):
    profile = json.loads((SCRIPTS / 'pixal3d-cuda-profile.json').read_text())
    cuda.install(root, cuda_home, profile=profile,
        locks=['requirements-pixal3d-cuda.lock.txt', 'requirements-pixal3d-cuda-build.lock.txt'],
        packages=['flash-attention', 'nvdiffrast', 'nvdiffrec', 'CuMesh', 'FlexGEMM', '../o-voxel', 'pipeline', 'MoGe'],
        optional_packages=['natten'], runtime_patch=patch_runtime, build_patch=patch_build, verify=VERIFY)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('root', help='Runtime directory; model assets outside .conda are retained')
    parser.add_argument('--cuda-home', type=Path, default=Path('/usr/local/cuda-12.6'))
    args = parser.parse_args()
    install(args.root, args.cuda_home)


if __name__ == '__main__':
    main()
