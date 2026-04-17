# Product Principles

Design rules that govern SmartNote. Each principle has a tier (P0 / P1 / P2), a reason, and what it forbids.

## P0 — non-negotiable

### P0-1 · Single source of truth
- **Principle:** `raw.md` is the only original truth. `note.md`, tags, vectors, wiki — all derived.
- **Must:** Preserve raw verbatim. Every derived artifact carries a `source_ref` back to raw.
- **Must not:** Rewrite raw from AI output. Persist any derived view as if it were authoritative.

### P0-2 · Reversible and auditable
- **Principle:** Every AI-driven change is versioned and rollback-able.
- **Must:** Snapshot before rewrite (`versioning.py`). Log the prompt, model, and diff.
- **Must not:** Overwrite `note.md` without a snapshot. Run rewrite without an A/B preview.

### P0-3 · Local-first, iCloud as pure sync
- **Principle:** All core capabilities run offline. iCloud moves files, nothing else.
- **Must:** Work with cloud unreachable. Store state on disk, not in cloud services.
- **Must not:** Make iCloud a dependency for search, ingest, or answer.

### P0-4 · Incremental, not rebuild
- **Principle:** Process new/changed segments only. Full rebuild is an explicit user action.
- **Must:** Track cursor + content hash per segment. Additive updates preserve existing tags.
- **Must not:** Silently full-rebuild on every ingest.

### P0-5 · Capture speed beats everything
- **Principle:** The fastest path from "I thought of it" to "it's saved" wins.
- **Must:** Global hotkey appends clipboard to raw in a single keystroke (`⌃⇧N`).
- **Must not:** Require multiple clicks, dialogs, or mode switches to save an idea.

## P1 — default

### P1-1 · Evidence before conclusion
- **Principle:** Answers cite before they claim.
- **Must:** Every AI answer includes at least one `source_ref`. UI surfaces the cited chunk.
- **Must not:** Show a confident answer with no sources.

### P1-2 · Hybrid retrieval over single-path
- **Principle:** Six recall paths with adaptive fusion. No path is the single source of rank.
- **Must:** FTS + vector + n-gram + substring + keyword + tag metadata, combined.
- **Must not:** Ship a feature whose retrieval is single-path without justification.

### P1-3 · Pluggable capability
- **Principle:** Embedding, LLM, and MCP servers are all swap-in/swap-out.
- **Must:** Settings expose provider choice. Mock/FTS-only mode must work without any external service.
- **Must not:** Hard-code a specific provider or MCP server.

### P1-4 · Open formats, no lock-in
- **Principle:** Markdown + SQLite. Nothing proprietary.
- **Must:** Every artifact viewable in a plain editor. Export path always available.
- **Must not:** Invent a custom binary format when Markdown works.

### P1-5 · Explainable automation
- **Principle:** Every auto-decision (tag, classification, dedup, reorg) has a shown reason.
- **Must:** Surface the signal that drove the decision (keyword hit, similarity score, rule name).
- **Must not:** Ship opaque "AI said so" automation.

### P1-6 · Closed feedback loop
- **Principle:** Retrieval learns from use. Upvotes are training data.
- **Must:** Log query → answer → feedback. Feed signal into adaptive weights and memory.
- **Must not:** Throw away user feedback after showing the UI response.

### P1-7 · Organize by attribute, not file
- **Principle:** Dimensions (todo, work, learn, …) are tag metadata on segments, not separate files.
- **Must:** Filtering composes (tag + topic + free-text) without materializing per-dimension files.
- **Must not:** Duplicate content across view files to implement filtering.

## P2 — conditional

### P2-1 · Progressive intelligence
- Ship rule + lightweight model first. Add multi-agent orchestration only after the simpler pipeline is stable.

### P2-2 · macOS first, CLI second, iOS later
- macOS desktop is the primary product. MCP exposes the same capabilities to CLI clients. iOS comes post-commercialization.

### P2-3 · Accuracy via graph + learning-to-rank, not large-model fine-tuning
- Knowledge graph + rerank learning from `+1` signals before any generation-model fine-tune. Fine-tuning is last, not first.

### P2-4 · Graph always links back to text
- Entity/relation answers must cite the segment they came from. No detached graph claims.

## North-star metrics

| Dimension | Metric |
|-----------|--------|
| Capture | Hotkey success rate, write latency |
| Organize | Incremental-ingest latency, manual-correction rate |
| Retrieval | Top-3 hit rate, evidence-cited answer rate |
| Trust | `source_ref` coverage, rollback availability, misclassification rate |
| Extensibility | MCP server uptime, skill parse success |

## Convention

- Principle ids (`P0-1`, etc.) are stable and citable in PRs and code comments.
- Each milestone should touch at least 3 principles (add, revise, or retire).
- When a principle's "must not" gets violated intentionally, document why in the PR, not in this file.
