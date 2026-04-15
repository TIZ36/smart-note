import { useState, useEffect } from "react";
import { cn } from "@/lib/cn";

type Version = {
  version: string;
  reason: string;
  created_at: string;
  chunk_count: number;
};

export function VersionsPanel() {
  const [versions, setVersions] = useState<Version[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  function loadVersions() {
    fetch("http://127.0.0.1:8787/versions")
      .then((r) => r.json())
      .then((d) => setVersions(d.versions || []))
      .catch(() => setVersions([]))
      .finally(() => setLoading(false));
  }

  useEffect(() => { loadVersions(); }, []);

  async function handleRestore(versionId: string) {
    setBusy(versionId);
    try {
      await fetch("http://127.0.0.1:8787/versions/restore", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ version_id: versionId }),
      });
      loadVersions();
    } catch {}
    setBusy(null);
  }

  async function handleDelete(versionId: string) {
    setBusy(versionId);
    try {
      await fetch(`http://127.0.0.1:8787/versions/${encodeURIComponent(versionId)}`, {
        method: "DELETE",
      });
      loadVersions();
    } catch {}
    setBusy(null);
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex-1 overflow-y-auto">
        <div className="proto-page-content">
          <h1 className="proto-page-title">Knowledge Base Versions</h1>
          <p className="text-[13px] text-[var(--color-text-secondary)] mb-6 leading-relaxed">
            Versions are auto-created before each rebuild. Max 10 kept.
          </p>

          {loading ? (
            <p className="text-[13px] text-[var(--color-text-muted)]">Loading...</p>
          ) : versions.length === 0 ? (
            <p className="text-[13px] text-[var(--color-text-muted)]">No versions yet.</p>
          ) : (
            <div>
              {versions.map((v, i) => {
                const isCurrent = i === 0;
                return (
                  <div key={v.version} className="proto-version-item">
                    <div className={cn("proto-version-dot", !isCurrent && "proto-version-dot-old")} />
                    <div className="flex-1 min-w-0">
                      <div className="proto-version-id">{v.version}</div>
                      <div className="proto-version-meta">
                        {v.reason} · {v.chunk_count} chunks · {v.created_at}
                      </div>
                    </div>
                    {isCurrent ? (
                      <span className="proto-version-current">current</span>
                    ) : (
                      <div style={{ display: "flex", gap: 8 }}>
                        <button
                          type="button"
                          onClick={() => handleRestore(v.version)}
                          disabled={busy !== null}
                          className="proto-version-action"
                        >
                          Restore
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDelete(v.version)}
                          disabled={busy !== null}
                          className="proto-version-action"
                          style={{ color: "var(--color-danger)" }}
                        >
                          Delete
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
