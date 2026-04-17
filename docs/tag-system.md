# Tag System

How raw input becomes organized. Synced with `server/app/ai_enrich.py`, `autoclassify.py`, `tags.py`, `dimensions.py`.

## Default tags

| Tag | Content examples |
|-----|------------------|
| `learn` | Study notes, design rationale, tech deep-dives |
| `work` | Meeting notes, decisions, ownership |
| `todo` | Action items, tasks with due dates |
| `daily_life` | Non-work logs, errands, routines |
| `password` | Credentials, API keys, secrets (local-only, never committed) |
| `reminder` | Time-bound prompts |
| `hobby` | Personal projects, reading, interests |
| `others` | Fallback when no tag scores above threshold |

Users can add, reorder, recolor, or remove tags in Settings. Custom tags participate in the same classification pipeline as defaults.

## How classification happens

```
raw segment
   │
   ├─ Rule pass     ── keyword regex on obvious cases (password blocks, TODO markers)
   │
   ├─ Heuristic     ── tokenized bag-of-keywords per tag, weighted scoring
   │
   └─ AI pass       ── LLM classifier, consulted when heuristics ambiguous
         │
         ▼
  Segment row with tag array + confidence
```

Segments may carry multiple tags — a segment mentioning a TODO inside a project retro gets both `todo` and `work`.

## Why tags, not per-dimension files

The original design sketched `views/todo.md`, `views/requirements.md`, etc. — one file per dimension. We shipped tags instead:

- **Single source of truth.** Segment content lives in one place. Tags are metadata. No duplication, no sync logic.
- **Filters compose.** Tag filter + `@topic` scope + free-text query all combine without special cases.
- **Reclassification is cheap.** Changing a tag updates one row; no file rewrite.

The visible UX is the same — the sidebar shows per-tag counts, clicking a tag filters the view. Behind the scenes, there's just a query, not a materialized file.

## Filtering & scoping

- Tab key cycles tag filters in the search bar
- `@topic` scopes search to a wiki topic
- Combined: `@react  #learn  hook lifecycle` → React-topic + learn-tagged + free-text

## Auto-learning

When a user manually re-tags a segment, that correction feeds back:
- Heuristic weights for that tag adjust toward the corrected keywords
- The AI classifier sees recent corrections as few-shot examples on the next run

## Custom tags

Defined in `prefs.json` → `tags[]`:

```json
{
  "tags": [
    {"name": "learn", "color": "#8ecae6", "order": 0},
    {"name": "myproject", "color": "#fb8500", "order": 8}
  ]
}
```

The classifier picks up new tags automatically on next ingest. No schema change needed.
