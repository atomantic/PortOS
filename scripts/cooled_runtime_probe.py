"""Opt-in native probes for #15988; run in isolated, hash-installed environments.

No downloads, model weights, provider sessions or application data are used.
Consumer roots must be extracted, inspected, hash-verified upstream wheels.
"""
import argparse
import ast
import asyncio
import inspect
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


def sentencepiece_probe(directory, baseline):
    import sentencepiece as spm

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


async def reactor_probe():
    from reactor_sdk import Reactor
    from reactor_sdk._ffi import get_lib
    from reactor_sdk.track import Track, TrackList, TrackKind, TrackDirection

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


def pydantic_probe(vlm, gradio, client):
    import abc
    import typing
    import typing_extensions
    import pydantic

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


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("probe", choices=["sentencepiece", "reactor", "pydantic"])
    parser.add_argument("--fixtures", type=pathlib.Path)
    parser.add_argument("--baseline", action="store_true")
    parser.add_argument("--vlm", type=pathlib.Path)
    parser.add_argument("--gradio", type=pathlib.Path)
    parser.add_argument("--client", type=pathlib.Path)
    args = parser.parse_args()
    socket.create_connection = refuse_network
    socket.socket.connect = refuse_network
    if args.probe == "sentencepiece":
        if not args.fixtures:
            parser.error("--fixtures is required")
        sentencepiece_probe(args.fixtures, args.baseline)
    elif args.probe == "reactor":
        asyncio.run(reactor_probe())
    else:
        if not all([args.vlm, args.gradio, args.client]):
            parser.error("--vlm, --gradio and --client extracted wheel roots are required")
        pydantic_probe(args.vlm, args.gradio, args.client)
