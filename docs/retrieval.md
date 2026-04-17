# Retrieval & RAG Pipeline

How a query becomes an answer. Synced with `server/app/retrieval.py`, `rerank.py`, `adaptive.py`, `memory.py`.

## 4-stage pipeline

```
Query
  │
  ▼
[1] Recall     ── 6 parallel paths
  │
  ▼
[2] Rerank     ── embedding-similarity reorder
  │
  ▼
[3] Answer     ── LLM with cited evidence
  │
  ▼
[4] Strengthen ── feedback updates adaptive weights + memory
```

## Stage 1: Recall (6 paths)

All six run in parallel, then fuse with adaptive weights.

| Path | Signal | Good at | Weak at |
|------|--------|---------|---------|
| FTS5 | Exact word match (jieba-segmented for Chinese) | Known terms, proper nouns | Typos, synonyms |
| Substring (LIKE) | Partial string match | Sub-tokens FTS misses | Noisy on short queries |
| N-gram | Character n-gram overlap | Typos, fuzzy variants | Long queries |
| Vector | Cosine similarity on embeddings | Semantic paraphrase | Rare domain jargon |
| Keyword | Weighted domain-term match | Tagged technical content | Casual phrasing |
| Tag metadata | Segment classification filter | Scoped recall (`@topic`, tag filter) | Nothing unless user filters |

Fusion:

```
score = Σ w_i * path_i(query)
```

Weights live per-query-fingerprint in `adaptive_weights`. Default weights apply on cold start.

## Stage 2: Rerank

Top-N from recall go through `rerank.py`:
- Re-embed query against each candidate
- Reorder by cosine similarity
- Trim to final top-K

Why re-embed instead of trusting recall vector scores: recall vector score is one signal among six. Rerank isolates semantic match at the top of the list.

## Stage 3: Answer

`gateway.py` streams the answer over SSE:
- Build prompt with top-K evidence chunks, each carrying `source_ref`
- Stream LLM output token-by-token
- Require the model to cite by `source_ref`
- Show evidence panel on the right so the user can jump to the originating line

## Stage 4: Strengthen

Three feedback mechanisms update state:

1. **Upvote → adaptive weight update.** The path that contributed most to the upvoted answer gains weight for queries with matching fingerprint (`adaptive.py`).
2. **High-signal Q&A → memory.** After enough upvotes on similar questions, the answer gets distilled into `memories` and participates in future recall as a 7th virtual path (`memory.py`).
3. **Conflict & duplicate detection.** Post-ingest, `wiki_dedup.py` and conflict detection flag redundant or contradicting content for user resolution.

## Key tables

| Table | Purpose |
|-------|---------|
| `segments` | Chunked note content + tags + vector BLOB |
| `notes_fts` | FTS5 virtual table mirroring `segments.content` |
| `query_logs` | Every query, retrieval mode, latency |
| `answer_logs` | Answers with evidence refs, model, prompt version |
| `feedback_logs` | Upvotes and flags linked to answer ids |
| `memories` | Distilled high-quality Q&A templates |
| `adaptive_weights` | Per-fingerprint path weights |
| `kg_entities` · `kg_relations` | Entity graph extracted from segments |
| `wiki_topics` · `wiki_sources` | Curated per-topic knowledge |
| `conflicts` | Detected contradictions awaiting user resolution |

## Why hybrid, not single-path

Single vector retrieval fails on:
- Exact identifiers (function names, URLs, IDs)
- Typos in query
- Domain jargon outside the embedding model's training distribution
- Language mixing (Chinese/English)

FTS alone fails on:
- Synonyms and paraphrasing
- Conceptual queries ("how does X compare to Y")

Six paths with adaptive fusion cover the union. The cost is more code; the benefit is observably better recall on mixed real-world queries.

## Evaluation signals

- **Recall@K** on held-out queries with known good answers
- **Evidence-cited answer rate** (share of answers with at least one source_ref)
- **Upvote rate** over time as adaptive weights learn
- **Query latency p50/p95** on the `/ask` endpoint

Dashboard surfaces these live; see `components/dashboard/DashboardPanel.tsx`.
