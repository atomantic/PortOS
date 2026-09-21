# Qwen-Image 2.1

Choose **Local → Qwen-Image 2.1** in Image Gen. The model uses
`Qwen/Qwen-Image-2.1` and Diffusers' `QwenImage21Pipeline`, with 40 steps
and guidance disabled by default. Existing Qwen models remain available.
The registry adds the new choice to existing installs without changing their
selected model or customized settings.

Install or repair the shared FLUX.2 image runtime through the app, or run:

```sh
INSTALL_FLUX2=1 FLUX2_FORCE_REINSTALL=1 bash scripts/setup-image-video.sh
```

Both installers use current Diffusers from git and Transformers >=5.17.
An older runtime missing `QwenImage21Pipeline` reports the repair command
before loading weights. Setup does not download model weights; those load
when a render is requested.

Text-to-image and editing through **Init Image** and reference-image uploads
are supported, with up to ten image inputs in total. An Init Image uses one
slot, leaving nine reference-image slots. Editing preserves the reference's
aspect ratio and alpha channel; this unified pipeline does not use denoising
strength or per-reference strength controls. PNG output retains generated
transparency. For transparent output, explicitly describe an RGBA image with
an alpha channel and a transparent background in the prompt. PortOS does not
expose Qwen's separate-mask interface.

The model ships under the **Qwen Research License**, unlike the earlier
Apache-licensed Qwen image models. See the
[model and license](https://huggingface.co/Qwen/Qwen-Image-2.1) and
[upstream usage examples](https://github.com/QwenLM/Qwen-Image-2.1).
The integration's automated checks use fixture pipelines; they do not establish
render quality or hardware memory requirements for the full model.
