"""Telemetry context — persistence.

Owns reads/writes to: workspace_usage, workspace_usage_monthly,
search_history. Recent activity feed reads from processing_runs
through enrichment's service, not this repo.
"""
