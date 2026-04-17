# Raw input — paste anything here

Structure doesn't matter. SmartNote will chunk, classify, and index this automatically when you click **Ingest**.

---

TODO: book flight for Q3 offsite
TODO: review Jie's PR on retrieval.py

---

Meeting 2026-04-12 — RAG roadmap

- agreed to ship 6-path hybrid search in v0.9
- parked: knowledge graph UI until after feedback loop lands
- owner: me — follow up with design on source panel grouping

---

# Snippet: SQLite FTS5 setup

```sql
CREATE VIRTUAL TABLE notes_fts USING fts5(
  content,
  tokenize = 'unicode61 remove_diacritics 2'
);
```

Remember: jieba preprocesses Chinese text before insert — FTS5 itself is tokenizer-agnostic.

---

Password-style block (will be auto-classified as #password):

```
example-service
  user: demo@example.com
  note: replace with your real credentials or delete
```

---

## Project experience — Niho theme migration

Learned: starfield particles at 60fps need `will-change: transform` on the canvas parent, otherwise Chrome repaints the whole compositor layer. Fixed the jank by moving animation to `requestAnimationFrame` + CSS containment.

Gotcha: neon logo glow looked washed out on retina — had to bump `filter: drop-shadow` by 1.5x on devicePixelRatio > 1.

---

Random idea: MCP Skill Inspector could diff two skill versions side-by-side. Not urgent. Parking for v1.0.
