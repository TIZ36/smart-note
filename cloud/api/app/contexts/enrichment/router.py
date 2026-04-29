"""Enrichment context — HTTP transport (placeholder).

Existing routes (`/v1/enrich/*`, `/v1/enrich/provider`, `/v1/tags/*`)
still live in `app/routers/`. They migrate here once enrichment's
service.py absorbs the inline logic those routers carry today
(classifier dispatch, provider config CRUD, tag config CRUD).
"""
