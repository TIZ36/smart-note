"use client";
import { useMemo, useState } from "react";
import { PageHead } from "@/components/PageHead";
import { useDetail } from "@/components/DetailOverlay";
import { IconChev, IconSearch } from "@/components/icons";
import { fetchDocBody, listDocuments } from "@/lib/api";
import { useApi } from "@/lib/useApi";
import { cn, dotClass } from "@/lib/cn";
import type { DocItem } from "@/lib/types";

export default function DocumentsPage() {
  const [q, setQ] = useState("");
  const [kind, setKind] = useState("");
  const { open } = useDetail();

  const docsQ = useApi(() => listDocuments());
  const docs = docsQ.data ?? [];

  const filtered = useMemo(() => docs.filter((d) =>
    (!q || d.name.toLowerCase().includes(q.toLowerCase())) &&
    (!kind || d.kind === kind)
  ), [docs, q, kind]);

  function showDoc(d: DocItem) {
    open({
      title: d.name,
      sub: `${d.kind} · ${d.size}`,
      body: <DocBody initial={d} docId={d.id} />,
    });
  }

  return (
    <div className="page">
      <PageHead section="documents" title="Documents" status={<span>synced from Desktop</span>} />

      <div className="toolbar" style={{ marginTop: 24 }}>
        <div className="toolbar-search">
          <IconSearch />
          <input placeholder="Search by name…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <select value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="">All types</option>
          <option value="document">document</option>
          <option value="wiki">wiki</option>
          <option value="pdf">pdf</option>
        </select>
        <span className="toolbar-count">
          {docsQ.loading ? "loading…" : `${filtered.length} ${filtered.length === 1 ? "document" : "documents"}`}
        </span>
      </div>

      <div className="colhead docs-cols">
        <span /><span>Name</span><span>Type</span>
        <span className="ta-right">Chunks</span>
        <span className="ta-right">Size</span>
        <span className="ta-right">Updated</span>
        <span />
      </div>

      <div className="list">
        {docsQ.error   && <div className="empty">Failed to load: {docsQ.error}</div>}
        {!docsQ.error && !docsQ.loading && filtered.length === 0 && <div className="empty">No documents match.</div>}
        {filtered.map((d) => (
          <button key={d.id} className="row docs-cols" onClick={() => showDoc(d)}>
            <span className={cn("row-dot", dotClass(d.status))} />
            <span className="row-name">{d.name}</span>
            <span className="row-kind">{d.kind}</span>
            <span className="row-meta-right">{d.chunks || "—"}</span>
            <span className="row-meta-right">{d.size}</span>
            <span className="row-meta-right">{d.updated}</span>
            <span className="row-chev"><IconChev /></span>
          </button>
        ))}
      </div>
    </div>
  );
}

function DocBody({ initial, docId }: { initial: DocItem; docId: string }) {
  const { data, loading, error } = useApi(() => fetchDocBody(docId), [docId]);
  return (
    <>
      <section>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
          <span className={cn("status-pill", dotClass(initial.status))}><span className="d" />{initial.status}</span>
          <span style={{ color: "var(--muted)", fontSize: 11.5 }}>Updated {initial.updated}</span>
        </div>
        <dl className="kv">
          <dt>Doc ID</dt><dd className="mono">{initial.id}</dd>
          <dt>Type</dt>  <dd>{initial.kind}</dd>
          <dt>Size</dt>  <dd>{initial.size}</dd>
        </dl>
      </section>
      <section>
        <h4>Preview</h4>
        {loading && <div style={{ color: "var(--muted)", fontSize: 12 }}>loading…</div>}
        {error && <div style={{ color: "var(--danger)", fontSize: 12 }}>failed: {error}</div>}
        {data && <pre className="preview-block">{data.slice(0, 4000)}{data.length > 4000 ? "\n\n…" : ""}</pre>}
        <p style={{ color: "var(--muted)", fontSize: 11.5, marginTop: 10 }}>
          Read-only snapshot. Edit source from Desktop.
        </p>
      </section>
    </>
  );
}
