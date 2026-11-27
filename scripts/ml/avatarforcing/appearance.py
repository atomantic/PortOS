"""Independent tensor implementation of the AvatarForcing appearance autoencoder."""

from math import sqrt

import torch
from torch.nn import functional as F


def fir(x, kernel, before, after, up=1):
    n, c, h, w = x.shape
    flat = x.reshape(n * c, 1, h, w)
    if up == 2:
        flat = F.conv_transpose2d(flat, x.new_ones((1, 1, 1, 1)), stride=2, output_padding=1)
    flat = F.pad(flat, (before, after, before, after))
    filtered = F.conv2d(flat, kernel.flip((0, 1))[None, None])
    return filtered.reshape(n, c, *filtered.shape[-2:])


def scaled_conv(x, weight, stride=1, padding=0):
    return F.conv2d(x, weight / sqrt(weight[0].numel()), stride=stride, padding=padding)


def activate(x, bias):
    return F.leaky_relu(x + bias, 0.2) * sqrt(2)


def encode(x, weights):
    def w(key):
        return weights["motion_autoencoder.enc.net_app.convs." + key]

    x = activate(scaled_conv(x, w("0.0.weight")), w("0.1.bias"))
    pyramid = [x]
    for index in range(1, 8):
        prefix = str(index)
        side = scaled_conv(fir(x, w(prefix + ".skip.0.kernel"), 1, 1),
                           w(prefix + ".skip.1.weight"), stride=2)
        body = activate(scaled_conv(x, w(prefix + ".conv1.0.weight"), padding=1),
                        w(prefix + ".conv1.1.bias"))
        body = fir(body, w(prefix + ".conv2.0.kernel"), 2, 2)
        body = activate(scaled_conv(body, w(prefix + ".conv2.1.weight"), stride=2),
                        w(prefix + ".conv2.2.bias"))
        x = (side + body) / sqrt(2)
        pyramid.append(x)
    identity = scaled_conv(x, w("8.weight")).flatten(1)
    return identity, tuple(reversed(pyramid[:-1]))


def project_motion(identity, weights):
    x = identity
    for index in range(5):
        p = f"motion_autoencoder.enc.fc.{index}"
        coeff = weights[p + ".weight"]
        x = F.linear(x, coeff / sqrt(coeff.shape[1]), weights[p + ".bias"])
    matrix = weights["motion_autoencoder.dec.direction.weight"]
    # QR initialization is small; use the same float32 result on CPU/MPS.
    basis, _ = torch.linalg.qr(matrix.float().cpu() + 1e-8)
    return x @ basis.to(device=x.device, dtype=x.dtype).T


def styled_conv(x, style, w, prefix, *, up=False, demod=True):
    kernel = w(prefix + ".weight")[0]
    modulation = w(prefix + ".modulation.weight")
    gains = F.linear(style, modulation / sqrt(modulation.shape[1]), w(prefix + ".modulation.bias"))
    base = kernel / sqrt(kernel[0].numel())
    source = x * gains[:, :, None, None]
    if up:
        convolved = F.conv_transpose2d(source, base.transpose(0, 1), stride=2)
    else:
        convolved = F.conv2d(source, base, padding=base.shape[-1] // 2)
    if demod:
        # Pull the per-sample scaling outside the convolution, so the GPU
        # sees one ordinary convolution even for a batch of distinct styles.
        power = gains.float().square() @ base.float().square().sum((2, 3)).T
        convolved = convolved * (power + 1e-8).rsqrt().to(source.dtype)[:, :, None, None]
    return fir(convolved, w(prefix + ".blur.kernel"), 1, 1) if up else convolved


def decode(style, features, weights):
    def w(key):
        return weights["motion_autoencoder.dec." + key]

    def hidden(x, name, up=False):
        # Static deterministic test: no per-frame StyleGAN noise is injected.
        return activate(styled_conv(x, style, w, name + ".conv", up=up), w(name + ".activate.bias"))

    depth = style.shape[0]
    x = hidden(w("input.input").expand(depth, -1, -1, -1), "conv1")
    previous_flow = None
    previous_rgb = None
    for index, feature in enumerate(features):
        x = hidden(x, f"convs.{2 * index}", up=True)
        x = hidden(x, f"convs.{2 * index + 1}")
        p = f"to_flows.{index}"
        flow = styled_conv(x, style, w, p + ".conv", demod=False) + w(p + ".bias")
        if previous_flow is not None:
            flow += fir(previous_flow, w(p + ".upsample.kernel"), 2, 1, up=2)
        previous_flow = flow
        axis = torch.linspace(-1, 1, x.shape[-1], device=x.device, dtype=x.dtype)
        gy, gx = torch.meshgrid(axis, axis, indexing="ij")
        grid = torch.stack((gx, gy), dim=-1) + flow[:, :2].tanh().permute(0, 2, 3, 1)
        gate = flow[:, 2:3].sigmoid()
        warped = gate * F.grid_sample(feature.expand(depth, -1, -1, -1), grid, align_corners=False)
        x = warped + (1 - gate) * x
        p = f"to_rgbs.{index}"
        rgb = activate(scaled_conv(warped, w(p + ".conv.0.weight")),
                       w(p + ".conv.1.bias")) + w(p + ".bias")
        if previous_rgb is not None:
            rgb += fir(previous_rgb, w(p + ".upsample.kernel"), 2, 1, up=2)
        previous_rgb = rgb
    return previous_rgb
