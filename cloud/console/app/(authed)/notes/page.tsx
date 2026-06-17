"use client";
import { useMemo, useState } from "react";
import { PageHead } from "@/components/PageHead";
import { useDetail } from "@/components/DetailOverlay";
import { IconChev, IconSearch, IconStar } from "@/components/icons";
import { fetchDocBody, listNotes } from "@/lib/api";
import { useApi } from "@/lib/useApi";
import type { Note } from "@/lib/types";

export default function NotesPage() {
  const [q, setQ] = useState("");
  const [tag, setTag] = useState("");
  const { open } = useDetail();

  const notesQ = useApi(() => listNotes());
  const notes = notesQ.data ?? [];

  const filtered = useMemo(() => notes.filter((n) =>
    (!q || n.title.toLowerCase().includes(q.toLowerCase())) &&
    (!tag || (tag === "starred" ? n.tag === "starred" : n.tag !== "starred"))
  ), [notes, q, tag]);

  function showNote(n: Note) {
    open({
      title: n.title,
      sub: `Updated ${n.updated}${n.tag === "starred" ? " · starred" : ""}`,
      body: <NoteBody noteId={n.id} />,
    });
  }

  return (
    <div className="page">
      <PageHead
        section="notes"
        title="Notes"
        status={<span>{notes.length} {notes.length === 1 ? "note" : "notes"}</span>}
      />

      <div className="toolbar" style={{ marginTop: 24 }}>
        <div className="toolbar-search">
          <IconSearch />
          <input placeholder="Search title…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <select value={tag} onChange={(e) => setTag(e.target.value)}>
          <option value="">All notes</option>
          <option value="starred">starred</option>
          <option value="untagged">untagged</option>
        </select>
        <span className="toolbar-count">
          {notesQ.loading ? "loading…" : `${filtered.length} ${filtered.length === 1 ? "note" : "notes"}`}
        </span>
      </div>

      <div className="list" style={{ marginTop: 8 }}>
        {notesQ.error   && <div className="empty">Failed to load: {notesQ.error}</div>}
        {!notesQ.error && !notesQ.loading && filtered.length === 0 && <div className="empty">No notes match.</div>}
        {filtered.map((n) => (
          <button key={n.id} className="row notes-cols" onClick={() => showNote(n)}>
            <span className="row-dot s-idle" />
            <span className="row-main">
              <span className="row-name">{n.tag === "starred" && <IconStar />}{n.title}</span>
              <span className="row-snippet">{n.snippet || "—"}</span>
            </span>
            <span className="row-meta-right">{n.updated}</span>
            <span className="row-chev"><IconChev /></span>
          </button>
        ))}
      </div>
    </div>
  );
}

function NoteBody({ noteId }: { noteId: string }) {
  const { data, loading, error } = useApi(() => fetchDocBody(noteId), [noteId]);
  return (
    <section>
      <h4>Body</h4>
      {loading && <div style={{ color: "var(--muted)", fontSize: 12 }}>loading…</div>}
      {error   && <div style={{ color: "var(--danger)", fontSize: 12 }}>failed: {error}</div>}
      {data    && <pre className="preview-block">{data}</pre>}
    </section>
  );
}
