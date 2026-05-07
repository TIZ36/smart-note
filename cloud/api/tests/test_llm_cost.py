"""Smoke tests for app.services.llm_cost.

The cost numbers feed straight into the desktop's name-plate stage
modal and the log panel's per-run cost roll-up. Drift in these
rates without bumping the table = silent under-/over-reporting on
every customer's pipeline.
"""

from __future__ import annotations

import pytest

from app.services.llm_cost import MODEL_RATES, cost_usd, rate_label


def test_known_model_haiku():
    # 1M input tokens × $0.80 = $0.80; 250k output × $4 = $1.00; total = $1.80
    c = cost_usd(model="claude-haiku-4-5", input_tokens=1_000_000, output_tokens=250_000)
    assert c == pytest.approx(1.80, rel=1e-6)


def test_known_model_sonnet():
    c = cost_usd(model="claude-sonnet-4-6", input_tokens=10_000, output_tokens=2_000)
    # 10k × $3/MTok = $0.030; 2k × $15/MTok = $0.030; total = $0.060
    assert c == pytest.approx(0.060, rel=1e-6)


def test_unknown_model_returns_zero():
    # Per the contract: unknown models return 0.0 so the UI can show "—"
    # rather than an invented number.
    assert cost_usd(model="not-a-model", input_tokens=1_000_000, output_tokens=1_000_000) == 0.0


def test_self_hosted_embedding_is_zero():
    # bge-m3 is self-hosted; per-token billing not used.
    assert cost_usd(model="bge-m3", input_tokens=1_000_000, output_tokens=0) == 0.0


def test_none_model_returns_zero():
    assert cost_usd(model=None, input_tokens=1_000_000, output_tokens=0) == 0.0


def test_rate_label_known_model():
    rate = rate_label("claude-haiku-4-5")
    assert rate == {"input": "$0.80 / MTok", "output": "$4.00 / MTok"}


def test_rate_label_unknown_returns_none():
    assert rate_label("not-a-model") is None


def test_all_rates_table_entries_have_both_directions():
    """Every rate must declare both input and output. Catches typos
    where one side gets dropped during a model bump."""
    for model, rate in MODEL_RATES.items():
        assert rate.input_per_mtok >= 0, model
        assert rate.output_per_mtok >= 0, model
