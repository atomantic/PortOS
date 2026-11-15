"""Opt-in native probes for #15988/#16047; run in isolated, hash-installed environments.

No downloads, model weights, provider sessions or application data are used.
Consumer roots must be extracted, inspected, hash-verified upstream wheels.
The H3 and Metal probes also take inspected, immutable source checkouts.
"""
import argparse
import ast
import asyncio
import inspect
from importlib.metadata import version
import io
import json
import pathlib
import pickle
import socket
import sys
import types


def refuse_network(*args, **kwargs):
    raise AssertionError("The native fixture must stay offline")


def definitions(path, names, namespace):
    """Execute selected upstream definitions without heavyweight package initializers."""
    tree = ast.parse(path.read_text())
    nodes = [node for node in tree.body if getattr(node, "name", None) in names]
    assert {node.name for node in nodes} == set(names), (path.name, names)
    # FileData's documentation decorator is unrelated to its Pydantic contract.
    for node in nodes:
        if isinstance(node, ast.ClassDef):
            node.decorator_list = [d for d in node.decorator_list if not (
                isinstance(d, ast.Call) and isinstance(d.func, ast.Name) and d.func.id == "document"
            )]
    module = ast.Module(body=[ast.ImportFrom(module="__future__", names=[ast.alias(name="annotations")], level=0), *nodes], type_ignores=[])
    exec(compile(ast.fix_missing_locations(module), str(path), "exec"), namespace)


def expect_version(package, baseline, previous, candidate):
    expected = previous if baseline else candidate
    assert version(package) == expected, f"{package} must be {expected} for this probe"


def sentencepiece_probe(directory, baseline):
    import sentencepiece as spm

    expect_version("sentencepiece", baseline, "0.2.2", "0.2.3")
    directory.mkdir(parents=True, exist_ok=True)
    texts = ["A paper boat drifts.", "café 日本語", "  tabs\tand\nspaces  ", "🦊 unknown bytes", ""]
    results = {}
    for kind in ["unigram", "bpe"]:
        model = directory / (kind + ".model")
        if baseline:
            assert not model.exists(), "Reuse the original baseline fixture; do not retrain it"
            output = io.BytesIO()
            spm.SentencePieceTrainer.train(
                sentence_iterator=iter(texts[:-1] * 8), model_writer=output,
                model_type=kind, vocab_size=340, byte_fallback=True,
                hard_vocab_limit=False, num_threads=1, shuffle_input_sentence=False,
                minloglevel=2,
            )
            model.write_bytes(output.getvalue())
        raw = model.read_bytes()
        processor = spm.SentencePieceProcessor(model_proto=raw)
        assert processor.serialized_model_proto() == raw
        loaded = spm.SentencePieceProcessor()
        assert loaded.Load(str(model))
        assert loaded.get_piece_size() == processor.get_piece_size()
        assert loaded.LoadFromSerializedProto(raw)
        ids = processor.encode(texts, out_type=int)
        pieces = processor.encode(texts, out_type=str)
        decoded = [processor.decode(row) for row in ids]
        assert [processor.decode(row) for row in pieces] == decoded
        assert processor.encode(decoded, out_type=int) == ids
        assert pickle.loads(pickle.dumps(processor)).encode(texts, out_type=int) == ids
        special_processor = spm.SentencePieceProcessor(model_proto=raw, add_bos=True, add_eos=True)
        special = special_processor.encode(texts[0], out_type=int)
        assert special[0] == processor.bos_id() and special[-1] == processor.eos_id()
        legacy_pickle = directory / (kind + ".pickle")
        if baseline:
            legacy_pickle.write_bytes(pickle.dumps(processor))
        else:
            assert pickle.loads(legacy_pickle.read_bytes()).encode(texts, out_type=int) == ids
        if spm.__version__ == "0.2.3":
            assert pickle.loads(pickle.dumps(special_processor)).encode(texts[0], out_type=int) == special
            assert processor.decode([[], ids[0]]) == ["", decoded[0]]
        try:
            spm.SentencePieceProcessor(model_proto=b"invalid-model")
        except RuntimeError:
            pass
        else:
            raise AssertionError("Corrupt tokenizer model accepted")
        results[kind] = {"ids": ids, "pieces": pieces, "decoded": decoded, "special": special}
    expected = directory / "sentencepiece.json"
    if baseline:
        expected.write_text(json.dumps(results, ensure_ascii=False))
    else:
        assert results == json.loads(expected.read_text()), "Tokenizer semantics changed"
    print("SentencePiece: native BPE/unigram encode/decode, serialized models, pickle and invalid-model refusal passed")


async def reactor_probe(baseline):
    from reactor_sdk import Reactor
    from reactor_sdk._ffi import get_lib
    from reactor_sdk.track import Track, TrackList, TrackKind, TrackDirection

    expect_version("reactor-sdk", baseline, "1.13.0", "1.14.0")
    lib = get_lib()  # Loads and ABI-checks the actual bundled native library.
    for symbol in ["reactor_create_with_adm", "reactor_send_command", "reactor_upload_file", "reactor_disconnect"]:
        assert getattr(lib, symbol).argtypes
    reactor = Reactor("reactor/fast-h3", jwt="example-fixture-token")
    assert reactor.generation == "streamed"
    messages, frames = [], []
    reactor.on("message", messages.append)
    reactor._fire("message", {"type": "clip_generated"})
    assert messages == [{"type": "clip_generated"}]
    tracks = TrackList([Track(reactor, kind, TrackKind(kind), TrackDirection.RECVONLY) for kind in ["video", "audio"]])
    for kind, args in [("video", (b"\0" * 16, 2, 2, 1, 100, None)), ("audio", (b"\0" * 8, 4, 24000, 1))]:
        track = tracks.with_direction("recvonly").with_kind(kind).one()
        track.on_raw_frame(lambda *values: frames.append(values))
        reactor._fire(track._event, *args)
        assert frames[-1] == args
    inspect.signature(reactor.connect).bind()
    inspect.signature(reactor.send_command).bind("enqueue", {"prompt": "A paper boat drifts.", "seconds": 6})
    inspect.signature(reactor.upload_file).bind(pathlib.Path("example.png"))
    # Actual refusal paths must not attempt a command/upload before connecting.
    for operation in [lambda: reactor.send_command("enqueue", {}), lambda: reactor.upload_file("example.png")]:
        try:
            await operation()
        except RuntimeError as error:
            assert "call connect() first" in str(error)
        else:
            raise AssertionError("Disconnected operation accepted")
    await reactor.disconnect()
    assert reactor._handle is None
    reactor.close()
    print("Reactor: native ABI, construction, raw callbacks, command/upload signatures and offline refusal/disconnect passed; no connect attempted")


def pydantic_probe(vlm, gradio, client, baseline):
    import abc
    import typing
    import typing_extensions
    import pydantic

    expect_version("pydantic", baseline, "2.14.2", "2.14.3")
    expect_version("pydantic-core", baseline, "2.50.2", "2.50.4")
    module = types.ModuleType("cooled_upstream_models")
    sys.modules[module.__name__] = module
    ns = module.__dict__
    ns.update({name: getattr(typing, name) for name in ["Any", "Literal", "Optional", "Union"]})
    ns.update({name: getattr(pydantic, name) for name in ["BaseModel", "ConfigDict", "Field", "RootModel", "ValidationError", "ValidationInfo", "model_validator"]})
    ns["__name__"] = "cooled_upstream_models"
    ns.update(ABC=abc.ABC, abstractmethod=abc.abstractmethod, pathlib=pathlib,
              TypedDict=typing_extensions.TypedDict, NotRequired=typing_extensions.NotRequired)
    # Read literal defaults from the same inspected VLM wheel as the actual model.
    for node in ast.parse((vlm / "generate/image.py").read_text()).body:
        if isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name) and node.targets[0].id in {"DEFAULT_IMAGE_SIZE", "DEFAULT_IMAGE_STEPS", "DEFAULT_IMAGE_GUIDANCE"}:
            ns[node.targets[0].id] = ast.literal_eval(node.value)
    definitions(vlm / "server/schemas.py", ["FlexibleBaseModel", "ImageGenerationRequest"], ns)
    definitions(client / "utils.py", ["is_file_obj_with_meta"], ns)
    definitions(gradio / "data_classes.py", ["GradioBaseModel", "GradioModel", "FileDataMeta", "FileData", "ImageData", "SimplePredictBody"], ns)
    request = ns["ImageGenerationRequest"].model_validate({"prompt": "café 日本語", "n": 2, "response_format": "path", "example_extension": True})
    assert type(request).model_validate_json(request.model_dump_json()) == request
    assert request.example_extension is True and request.steps == ns["DEFAULT_IMAGE_STEPS"]
    file = ns["FileData"].model_validate({"path": "example.png", "size": 12, "meta": {"_type": "gradio.FileData"}}, context={"validate_meta": True})
    assert ns["FileData"].from_json(json.loads(file.model_dump_json())) == file
    image = ns["ImageData"](path="example.png", size=12)
    assert ns["ImageData"].model_validate_json(image.model_dump_json()) == image
    body = ns["SimplePredictBody"](data=[json.loads(file.model_dump_json()), None, "日本語"])
    assert ns["SimplePredictBody"].model_validate_json(body.model_dump_json()) == body
    assert ns["ImageGenerationRequest"].model_json_schema()["properties"]["n"]["maximum"] == 10
    for model, data, context in [
        (type(request), {"prompt": "example", "n": 0}, None),
        (type(request), {"prompt": "example", "output_format": "invalid"}, None),
        (type(file), {"path": "example.png"}, {"validate_meta": True}),
        (type(file), {"path": 42}, None),
    ]:
        try:
            model.model_validate(data, context=context)
        except pydantic.ValidationError:
            pass
        else:
            raise AssertionError("Invalid upstream schema input accepted")
    print("Pydantic: actual VLM/Gradio schema definitions validate, serialize, round-trip and reject invalid inputs; package initializers/inference not executed")


def h3_transformers_probe(source, directory, baseline):
    import importlib.util
    import numpy as np
    from PIL import Image
    from tokenizers import Tokenizer, models, pre_tokenizers
    from transformers import PreTrainedTokenizerFast, Qwen2VLImageProcessorPil
    import generate_minimax_h3 as runner

    expect_version("transformers", baseline, "5.22.1", "5.22.2")
    assert not any(importlib.util.find_spec(name) for name in ("torch", "torchvision"))
    runner.register_source_namespace("minimax_h3_mlx", source / "minimax_h3_mlx")
    from minimax_h3_mlx.text_encoder import MiniMaxH3TextEncoder
    from minimax_h3_mlx.config import TAG_TEXT, TAG_VIDEO

    runner.verify_pinned_encode_source(MiniMaxH3TextEncoder.encode)
    if baseline:
        assert not directory.exists(), "Reuse the original baseline fixtures; do not overwrite them"
        directory.mkdir(parents=True)
        tokenizer = Tokenizer(models.WordLevel({
            "[UNK]": 0, "<|vision_start|>": 1, "<|image_pad|>": 2,
            "<|vision_end|>": 3, "paper": 4, "boat": 5, "café": 6,
        }, unk_token="[UNK]"))
        tokenizer.pre_tokenizer = pre_tokenizers.WhitespaceSplit()
        PreTrainedTokenizerFast(
            tokenizer_object=tokenizer, unk_token="[UNK]",
            additional_special_tokens=["<|vision_start|>", "<|image_pad|>", "<|vision_end|>"],
        ).save_pretrained(directory / "tokenizer")
        Qwen2VLImageProcessorPil(
            patch_size=16, temporal_patch_size=2, merge_size=2,
            size={"shortest_edge": 4096, "longest_edge": 16384},
        ).save_pretrained(directory / "processor")
        config_path = directory / "processor" / "preprocessor_config.json"
        config = json.loads(config_path.read_text())
        config["image_processor_type"] = "Qwen2VLImageProcessorFast"
        config_path.write_text(json.dumps(config))

    # Bypass weight construction only; request presentation, local tokenizer
    # loading and the PortOS PIL adapter all execute their real implementations.
    encoder = MiniMaxH3TextEncoder.__new__(MiniMaxH3TextEncoder)
    encoder._model_dir = directory / "text_encoder"
    encoder._tokenizer = encoder._processor = None
    runner.install_pil_image_processor()
    assert not runner.torch_image_stack_available()
    images = [Image.fromarray(np.arange(96 * 64 * 3, dtype=np.uint8).reshape(64, 96, 3))]
    images.append(images[0].transpose(Image.Transpose.FLIP_LEFT_RIGHT))
    actual = {}
    for index, (prompt, keyframes) in enumerate([
        ("paper boat", None), ("  café\tboat\n🦊  ", None), ("", None),
        ("paper " * 1200, None), ("paper boat", images[:1]), ("café", images),
    ]):
        ids, tags, vision = encoder.build_request(prompt, keyframes)
        ids = np.asarray(ids)
        assert ids.shape == (1, len(tags))
        if keyframes:
            values, grid = vision
            assert np.isfinite(values).all() and len(grid) == len(keyframes)
            assert np.count_nonzero(tags == TAG_VIDEO) == sum(
                int(row.prod()) // encoder.processor.image_processor.merge_size ** 2 + 2
                for row in grid
            )
            actual[f"{index}_pixels"] = values
            actual[f"{index}_grid"] = grid
        else:
            assert vision is None and np.all(tags == TAG_TEXT)
            assert ids.tolist() == [encoder.tokenizer(prompt, add_special_tokens=False)["input_ids"]]
        actual[f"{index}_ids"] = ids
        actual[f"{index}_tags"] = tags
    try:
        encoder.build_request(None)
    except ValueError:
        pass
    else:
        raise AssertionError("Non-string prompt accepted")
    expected_path = directory / "h3-transformers.npz"
    if baseline:
        np.savez(expected_path, **actual)
    else:
        with np.load(expected_path, allow_pickle=False) as expected:
            assert set(actual) == set(expected.files)
            for key, value in actual.items():
                np.testing.assert_array_equal(value, expected[key], err_msg=key)
    print("H3: real tokenizer, PIL adapter and pinned request builder passed six text/keyframe cases; no weights or inference")


def metal_transformers_probe(pixal, trellis, directory, baseline):
    import numpy as np
    from PIL import Image
    import torch
    import torch.nn as nn
    import torch.nn.functional as F
    from torchvision import transforms
    from transformers import DINOv3ViTConfig, DINOv3ViTModel, AutoModelForImageSegmentation

    expect_version("transformers", baseline, "5.22.1", "5.22.2")
    assert version("torch") == "2.15.0" and version("torchvision") == "0.29.2"
    assert torch.backends.mps.is_available(), "Run this probe on Apple Silicon with MPS"
    assert AutoModelForImageSegmentation is not None
    directory.mkdir(parents=True, exist_ok=True)
    model_path = directory / "tiny-dinov3"
    if baseline:
        assert not model_path.exists(), "Reuse the saved baseline model; do not regenerate it"
        torch.manual_seed(16047)
        model = DINOv3ViTModel(DINOv3ViTConfig(
            hidden_size=32, intermediate_size=64, num_hidden_layers=2,
            num_attention_heads=4, patch_size=16, image_size=32,
            num_register_tokens=4,
        ))
        model.save_pretrained(model_path)
    namespace = {
        "torch": torch, "nn": nn, "F": F, "np": np,
        "transforms": transforms, "Image": Image, "DINOv3ViTModel": DINOv3ViTModel,
    }
    definitions(pixal / "pixal3d/trainers/flow_matching/mixins/image_conditioned_proj.py", [
        "project_points_to_image_batch", "sample_features", "ProjGrid", "DinoV3ProjFeatureExtractor",
    ], namespace)
    definitions(trellis / "trellis2/modules/image_feature_extractor.py", ["DinoV3FeatureExtractor"], namespace)
    # TRELLIS's installer applies its pinned mps_compat.py patch before rendering.
    extractor_class = namespace["DinoV3FeatureExtractor"]
    assert hasattr(extractor_class, "device"), "Apply the pinned TRELLIS MPS patches first"
    pixels = np.arange(32 * 32 * 3, dtype=np.uint8).reshape(32, 32, 3)
    image = Image.fromarray(pixels)
    inputs = [
        [image], [image.convert("L"), image.convert("RGBA")],
        torch.from_numpy(pixels.copy()).permute(2, 0, 1).float().unsqueeze(0) / 255,
    ]
    actual = {}
    for device in ["cpu", "mps"]:
        pixal_extractor = namespace["DinoV3ProjFeatureExtractor"](
            str(model_path), image_size=32, grid_resolution=2, use_naf_upsample=False,
        ).to(device)
        trellis_extractor = extractor_class(str(model_path), image_size=32)
        trellis_extractor.to(device)
        for index, value in enumerate(inputs):
            batch = len(value)
            if isinstance(value, torch.Tensor):
                value = value.to(device)
            with torch.no_grad():
                features = trellis_extractor(value)
                global_features, projection = pixal_extractor(
                    value, camera_angle_x=torch.full((batch,), 0.8, device=device),
                    distance=torch.full((batch,), 3.0, device=device),
                    mesh_scale=torch.ones(batch, device=device),
                )
            assert features.shape == (batch, 9, 32)
            assert global_features.shape == (batch, 5, 32)
            assert projection.shape == (batch, 8, 32)
            for name, output in [("trellis", features), ("global", global_features), ("projection", projection)]:
                assert torch.isfinite(output).all() and output.abs().max() > 0
                actual[f"{device}_{index}_{name}"] = output.detach().cpu().numpy()
        for extractor in [pixal_extractor, trellis_extractor]:
            try:
                extractor("invalid image")
            except ValueError:
                pass
            else:
                raise AssertionError("Invalid image type accepted")
        try:
            pixal_extractor([image])
        except ValueError as error:
            assert "camera_angle_x" in str(error)
        else:
            raise AssertionError("Missing camera parameters accepted")
    expected_path = directory / "metal-transformers.npz"
    if baseline:
        np.savez(expected_path, **actual)
    else:
        with np.load(expected_path, allow_pickle=False) as expected:
            assert set(actual) == set(expected.files)
            for key, value in actual.items():
                np.testing.assert_allclose(value, expected[key], rtol=1e-6, atol=1e-6, err_msg=key)
        print("Metal: baseline/candidate DINOv3 features and Pixal projections agree on CPU/MPS; no production weights or NAF")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("probe", choices=["sentencepiece", "reactor", "pydantic", "h3-transformers", "metal-transformers"])
    parser.add_argument("--fixtures", type=pathlib.Path)
    parser.add_argument("--baseline", action="store_true")
    parser.add_argument("--vlm", type=pathlib.Path)
    parser.add_argument("--gradio", type=pathlib.Path)
    parser.add_argument("--client", type=pathlib.Path)
    parser.add_argument("--source", type=pathlib.Path)
    parser.add_argument("--trellis-source", type=pathlib.Path)
    args = parser.parse_args()
    socket.create_connection = refuse_network
    socket.socket.connect = refuse_network
    if args.probe == "sentencepiece":
        if not args.fixtures:
            parser.error("--fixtures is required")
        sentencepiece_probe(args.fixtures, args.baseline)
    elif args.probe == "reactor":
        asyncio.run(reactor_probe(args.baseline))
    elif args.probe == "h3-transformers":
        if not all([args.source, args.fixtures]):
            parser.error("--source and --fixtures are required")
        h3_transformers_probe(args.source, args.fixtures, args.baseline)
    elif args.probe == "metal-transformers":
        if not all([args.source, args.trellis_source, args.fixtures]):
            parser.error("--source, --trellis-source and --fixtures are required")
        metal_transformers_probe(args.source, args.trellis_source, args.fixtures, args.baseline)
    else:
        if not all([args.vlm, args.gradio, args.client]):
            parser.error("--vlm, --gradio and --client extracted wheel roots are required")
        pydantic_probe(args.vlm, args.gradio, args.client, args.baseline)
