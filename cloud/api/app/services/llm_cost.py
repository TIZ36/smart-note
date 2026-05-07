"""LLM cost computation — token counts × per-model rates.

Surfaced in pipeline events so the desktop and log panel can show
$ per stage / per run / per workspace without asking each executor
to compute cost itself.

Rates are USD per million tokens. Add new models as we onboard them.
The unknown-model fallback intentionally returns 0.0 rather than
guessing — better to show "—" than to invent a number.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional


@dataclass(frozen=True)
class ModelRate:
    input_per_mtok: float   # USD per million input tokens
    output_per_mtok: float  # USD per million output tokens


# Public rates as of model GA. Bump when Anthropic/Cloud provider
# pricing changes; downstream just sees the new cost_usd numbers.
MODEL_RATES: dict[str, ModelRate] = {
    # Anthropic Claude family
    "claude-haiku-4-5":      ModelRate(0.80, 4.00),
    "claude-haiku-4-5-20251001": ModelRate(0.80, 4.00),
    "claude-sonnet-4-6":     ModelRate(3.00, 15.00),
    "claude-opus-4-7":       ModelRate(15.00, 75.00),
    # Embedding (per-token billing not used — kept for completeness)
    "bge-m3":                ModelRate(0.0, 0.0),  # self-hosted
}


def cost_usd(
    *,
    model: Optional[str],
    input_tokens: int,
    output_tokens: int,
) -> float:
    """Return USD cost for the given (model, tokens). Unknown models
    return 0.0 — callers should also surface `model` so the UI can
    flag "rate unknown" rather than "free".
    """
    if not model:
        return 0.0
    rate = MODEL_RATES.get(model)
    if rate is None:
        return 0.0
    in_usd  = (input_tokens or 0) / 1_000_000.0 * rate.input_per_mtok
    out_usd = (output_tokens or 0) / 1_000_000.0 * rate.output_per_mtok
    return round(in_usd + out_usd, 6)


def rate_label(model: Optional[str]) -> Optional[dict[str, str]]:
    """Human-readable rate strings for UI ("$0.80 / MTok").
    Returns None if the model isn't in the table.
    """
    if not model:
        return None
    rate = MODEL_RATES.get(model)
    if rate is None:
        return None
    return {
        "input": f"${rate.input_per_mtok:.2f} / MTok",
        "output": f"${rate.output_per_mtok:.2f} / MTok",
    }
