"""Align pinned MoGe metadata with the CLI lane before a --no-deps install.

MoGe 07444410 declares Gradio and opencv-python, and Git URLs for utils3d and
pipeline. This lane installs none of the web demo, one headless OpenCV wheel,
and the hashed utils3d/pipeline archives. pip check reads the installed
metadata, so the patch has to land before that install.
"""
import sys
from pathlib import Path


def replace_once(text, before, after):
    if text.count(before) != 1:
        raise SystemExit('The pinned MoGe metadata interface changed: ' + before[:80])
    return text.replace(before, after)


def patch_text(text):
    text = replace_once(
        text,
        'utils3d @ git+https://github.com/EasternJournalist/utils3d.git@3fab839f0be9931dac7c8488eb0e1600c236e183',
        'utils3d==0.0.2',
    )
    text = replace_once(
        text,
        'pipeline @ git+https://github.com/EasternJournalist/pipeline.git@866f059d2a05cde05e4a52211ec5051fd5f276d6',
        'pipeline==1.0.0',
    )
    text = replace_once(text, '    "gradio",\n', '')
    return replace_once(text, '"opencv-python"', '"opencv-python-headless"')


def main():
    path = Path(sys.argv[1])
    if path.is_dir():
        path = path / 'pyproject.toml'
    path.write_text(patch_text(path.read_text()))


if __name__ == '__main__':
    main()
