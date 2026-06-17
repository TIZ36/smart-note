"use client";
import { useEffect, useRef, useState } from "react";
import { PageHead } from "@/components/PageHead";
import { useDetail } from "@/components/DetailOverlay";
import { IconGlobe } from "@/components/icons";
import { askCloud, fetchDocBody } from "@/lib/api";
import type { AskResult } from "@/lib/types";

const SUGGESTS = [
  "How does cloud merge handle conflicts?",
  "What models are configured for enrichment?",
  "Show recent failed runs and likely causes",
  "Summarize the pricing experiments note",
];

export default function AskPage() {
  const [q, setQ] = useState("");
  const [result, setResult] = useState<AskResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const { open } = useDetail();

  useEffect(() => { taRef.current?.focus(); }, []);

  async function ask(question = q) {
    const text = question.trim();
    if (!text || busy) return;
    setQ(text); setBusy(true); setError(null); setResult(null);
    try { setResult(await askCloud(text)); }
    catch (e: unknown) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  // Citation opens the cited doc/note in the same right-side detail drawer.
  function openCitation(c: AskResult["citations"][number]) {
    open({
      title: c.title,
      sub: c.meta,
      body: <CitedSource sourceId={extractIdFromTitle(c.title)} />,
    });
  }

  return (
    <div className="page">
      <PageHead
        section="ask"
        title="Ask your cloud"
        showLiveDot={false}
        status={<span>retrieval · hybrid (vector + lexical)</span>}
      />

      <div className="ask-composer">
        <textarea
          ref={taRef}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Ask anything about your notes, documents, and wiki…"
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); ask(); }
          }}
        />
        <div className="ask-bar">
          <span className="ask-scope">
            <IconGlobe />
            Scope: all cloud sources
          </span>
          <span className="ask-actions">
            <span className="kbdhint"><kbd>⌘</kbd>+<kbd>↵</kbd> to ask</span>
            <button className="btn-primary" disabled={!q.trim() || busy} onClick={() => ask()}>
              {busy ? "Asking…" : "Ask"}
            </button>
          </span>
        </div>
      </div>

      <div className="ask-suggest">
        {SUGGESTS.map((s) => (
          <button key={s} className="ask-chip" onClick={() => ask(s)}>{s}</button>
        ))}
      </div>

      {error && <div className="ask-empty" style={{ color: "var(--danger)" }}>Failed: {error}</div>}

      {!result && !error && !busy && (
        <div className="ask-empty">
          Ask a question to see the top sources from your cloud workspace.
        </div>
      )}

      {result && (
        <div className="ask-result">
          <div>
            <p className="ask-answer" dangerouslySetInnerHTML={{ __html: result.answer }} />
            <div className="ask-meta" style={{ marginTop: 14 }}>
              <span>{result.model}</span>
              <span className="ask-meta-sep" />
              <span>{result.citations.length} sources</span>
              <span className="ask-meta-sep" />
              <span>{result.latencyMs}ms</span>
              <span className="ask-meta-sep" />
              <span>est. {result.cost}</span>
            </div>
          </div>
          <div className="citations">
            <h4>Sources</h4>
            {result.citations.length === 0 && (
              <div className="empty">No matches in your workspace.</div>
            )}
            {result.citations.map((c) => (
              <button key={c.n} className="citation" onClick={() => openCitation(c)}>
                <span className="citation-num">{c.n}</span>
                <span className="citation-body">
                  <span className="citation-title">{c.title}</span>
                  <span className="citation-meta">{c.meta}</span>
                </span>
                <span className="citation-right">{c.score}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// Citation titles look like "<doc_name>" or "<kind> · <8-char id>".
// Pull the id out of the latter so we can fetch the body; for the
// former just return the name (fetchDocBody only works with UUIDs,
// so we fall back to a friendly "open from Documents" message).
function extractIdFromTitle(raw: string): string | null {
  const m = raw.match(/·\s*([a-f0-9-]{8,})$/i);
  return m ? m[1] : null;
}

function CitedSource({ sourceId }: { sourceId: string | null }) {
  const [body, setBody] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (!sourceId) return;
    let alive = true;
    fetchDocBody(sourceId).then(
      (b) => alive && setBody(b),
      (e) => alive && setErr(e instanceof Error ? e.message : String(e)),
    );
    return () => { alive = false; };
  }, [sourceId]);

  if (!sourceId) {
    return (
      <section>
        <h4>Source</h4>
        <p style={{ color: "var(--muted)", fontSize: 12.5 }}>
          This citation points to a memory chunk rather than a full document. Open the parent document from the Documents tab to read the full context.
        </p>
      </section>
    );
  }
  return (
    <section>
      <h4>Body</h4>
      {!body && !err && <div style={{ color: "var(--muted)", fontSize: 12 }}>loading…</div>}
      {err && <div style={{ color: "var(--danger)", fontSize: 12 }}>failed: {err}</div>}
      {body && <pre className="preview-block">{body.slice(0, 4000)}{body.length > 4000 ? "\n\n…" : ""}</pre>}
    </section>
  );
}
