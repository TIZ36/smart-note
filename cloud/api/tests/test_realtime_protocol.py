"""Smoke tests for app.services.realtime_protocol.

Verifies the v3.6 contract:
  - event_payload() preserves required envelope fields
  - new `note_classify` is in the Stage Literal
  - cost/model fields land in `data`, not stripped by the helper

The persistence path (broadcast → pipeline_events insert) needs
DB and is exercised by integration tests, not here.
"""

from __future__ import annotations

from app.services.realtime_protocol import event_payload


def test_envelope_fields_present():
    p = event_payload(
        event="enrich_done",
        workspace_id="ws-1",
        document_id="doc-1",
        run_id="run-1",
        stage="ai_enrich",
        status="done",
    )
    # Mandatory envelope per the contract
    for key in ("type", "event", "schema_version", "at",
                "workspace_id", "document_id", "run_id",
                "stage", "status"):
        assert key in p, f"missing envelope key: {key}"
    assert p["event"] == "enrich_done"
    assert p["type"] == "enrich_done"  # legacy compat
    assert p["schema_version"] == 1


def test_progress_serialized_when_present():
    p = event_payload(
        event="enrich_progress",
        workspace_id="ws-1",
        document_id="doc-1",
        run_id="run-1",
        stage="ai_enrich",
        status="running",
        progress_current=3,
        progress_total=8,
    )
    assert p["progress"] == {"current": 3, "total": 8}


def test_data_block_round_trips():
    """The `data` block carries the new v3.6 telemetry (cost,
    tokens, model, mode). Make sure it lands intact."""
    data = {
        "model": "claude-haiku-4-5",
        "cost_usd": 0.0042,
        "input_tokens": 5200,
        "output_tokens": 460,
        "mode": "user_dict_constrained",
    }
    p = event_payload(
        event="note_classify_done",
        workspace_id="ws-1",
        document_id="doc-1",
        run_id="run-1",
        stage="note_classify",
        status="done",
        data=data,
    )
    assert p["data"] == data
    assert p["stage"] == "note_classify"


def test_stage_kind_alias():
    """`kind` must mirror `stage` for older Desktop builds — the
    legacy WS consumer keys on `kind`."""
    p = event_payload(
        event="chunk_embed_done",
        workspace_id="ws-1",
        stage="chunk_embed",
        status="done",
    )
    assert p["stage"] == "chunk_embed"
    assert p.get("kind") == "chunk_embed"


def test_legacy_kwargs_pass_through():
    p = event_payload(
        event="enrich_done",
        workspace_id="ws-1",
        stage="ai_enrich",
        status="done",
        # extras for legacy consumers
        document_name="spec_v2.pdf",
        segments_count=42,
    )
    assert p["document_name"] == "spec_v2.pdf"
    assert p["segments_count"] == 42
