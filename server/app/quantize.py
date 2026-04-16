"""Int8 embedding quantization.

Float32 embeddings (512 dims × 4 bytes = 2KB per chunk) dominate row size at
scale. Int8 quantization + scale (512 + 4 = 516 bytes) is ~4x smaller and
cosine math on int8 is 2-3x faster under numpy.

Quantization strategy: per-vector max-absolute scale. Scalar `scale = max(|v|)`;
store `round(v / scale * 127)` as int8. To recover approx cosine, store scale
separately.

Cosine(a, b) == (a_int / 127 * a_scale) · (b_int / 127 * b_scale) / (|a| |b|).
Since the dot product numerator and denominator both scale by a_scale * b_scale,
those cancel in cosine — making int8 cosine nearly free to compute *without*
dequantizing. We still need the unit-norm guarantee; we compute int-norms on
the fly.
"""

from __future__ import annotations


def quantize_int8(vec: list[float]) -> tuple[bytes, float]:
    """Return (int8 bytes, scale). Safe for empty/zero vectors (scale=0)."""
    if not vec:
        return b"", 0.0
    max_abs = 0.0
    for v in vec:
        av = v if v >= 0 else -v
        if av > max_abs:
            max_abs = av
    if max_abs < 1e-12:
        return bytes(len(vec)), 0.0  # all-zero → zero bytes + scale 0
    scale = max_abs
    out = bytearray(len(vec))
    inv = 127.0 / scale
    for i, v in enumerate(vec):
        iv = int(round(v * inv))
        if iv > 127:
            iv = 127
        elif iv < -128:
            iv = -128
        out[i] = iv & 0xFF
    return bytes(out), scale


def dequantize_int8(blob: bytes, scale: float) -> list[float]:
    if not blob or scale == 0:
        return []
    inv = scale / 127.0
    return [(b if b < 128 else b - 256) * inv for b in blob]


def cosine_int8_numpy(blob_a: bytes, scale_a: float, blob_b: bytes, scale_b: float):
    """Fast numpy int8 cosine. Returns a float in [-1, 1] or 0 on zero-length."""
    try:
        import numpy as np
    except ImportError:
        return cosine_int8(blob_a, scale_a, blob_b, scale_b)
    if not blob_a or not blob_b or scale_a == 0 or scale_b == 0:
        return 0.0
    a = np.frombuffer(blob_a, dtype=np.int8).astype(np.int32)
    b = np.frombuffer(blob_b, dtype=np.int8).astype(np.int32)
    if a.size == 0 or b.size == 0 or a.size != b.size:
        return 0.0
    dot = float((a * b).sum())
    na = float((a * a).sum()) ** 0.5
    nb = float((b * b).sum()) ** 0.5
    if na < 1e-12 or nb < 1e-12:
        return 0.0
    # Scales cancel in cosine — int8 math is dimensionless once normalized.
    return dot / (na * nb)


def cosine_int8(blob_a: bytes, scale_a: float, blob_b: bytes, scale_b: float) -> float:
    """Pure-python fallback (no numpy). ~20x slower but still works."""
    if not blob_a or not blob_b or scale_a == 0 or scale_b == 0:
        return 0.0
    if len(blob_a) != len(blob_b):
        return 0.0
    dot = 0
    sa = 0
    sb = 0
    for i in range(len(blob_a)):
        a = blob_a[i]
        b = blob_b[i]
        ai = a if a < 128 else a - 256
        bi = b if b < 128 else b - 256
        dot += ai * bi
        sa += ai * ai
        sb += bi * bi
    if sa == 0 or sb == 0:
        return 0.0
    na = sa ** 0.5
    nb = sb ** 0.5
    return dot / (na * nb)
