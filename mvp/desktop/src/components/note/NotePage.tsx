import { useState, useEffect, useCallback } from "react";
import { Database, ChevronDown } from "lucide-react";
import { NoteEditor } from "../editor/NoteEditor";
import { IngestDialog } from "./IngestDialog";
import { pickRawFile, readFileFull, saveRawPathForHotkey } from "@/lib/electron";
import * as api from "@/lib/api";
import type { IngestStep } from "@/App";

type Props = {
  rawPath: string;
  notePath: string;
  onSetRawPath: (p: string) => void;
  onSetNotePath: (p: string) => void;
  onIngestComplete: () => void;
  ingestBusy: boolean;
  ingestSteps: IngestStep[];
  ingestResult: { message: string; type: "success" | "error" } | null;
};

export function NotePage({ rawPath, notePath, onSetRawPath, onSetNotePath, onIngestComplete, ingestBusy, ingestSteps, ingestResult }: Props) {
  const [showIngest, setShowIngest] = useState(false);
  const [activeBuild, setActiveBuild] = useState<string | null>(null);

  useEffect(() => {
    api.fetchBuilds().then((d) => {
      const active = d.builds.find((b) => b.is_active);
      if (active) setActiveBuild(active.id);
    }).catch(() => {});
  }, [ingestResult]);

  async function handlePickFile() {
    const p = await pickRawFile();
    if (p) {
      onSetRawPath(p);
      saveRawPathForHotkey(p).catch(() => {});
      // Auto-set note path in same directory
      const dir = p.replace(/\/[^/]+$/, "");
      onSetNotePath(`${dir}/note.md`);
    }
  }

  const handleSave = useCallback(async (content: string) => {
    try {
      const d = (window as any).desktop;
      if (d) {
        await d.invoke("write_file", { path: rawPath, content });
      }
    } catch {}
  }, [rawPath]);

  // First time: no file selected
  if (!rawPath) {
    return (
      <div className="flex flex-col h-full min-h-0">
        <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div style={{ textAlign: "center", maxWidth: 360 }}>
            <h2 style={{ fontSize: 16, fontWeight: 600, marginBottom: 12, color: "var(--color-text-primary)" }}>Open a Note</h2>
            <p style={{ fontSize: 13, color: "var(--color-text-secondary)", lineHeight: 1.6, marginBottom: 24 }}>
              Select your raw note file from iCloud Drive or local storage. This will be your primary knowledge source.
            </p>
            <button type="button" onClick={handlePickFile} className="proto-btn proto-btn-primary" style={{ width: "100%", justifyContent: "center" }}>
              Choose file
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Top bar */}
      <div className="proto-view-header">
        <span style={{ cursor: "pointer" }} onClick={handlePickFile} title="Click to change file">
          {rawPath.split("/").pop()}
        </span>
        <span className="proto-view-header-file">{rawPath}</span>
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8 }}>
          {activeBuild && (
            <span style={{ fontSize: 11, color: "var(--color-text-muted)", fontFamily: "ui-monospace, monospace" }}>
              v{activeBuild}
            </span>
          )}
          <button
            type="button"
            onClick={() => setShowIngest(true)}
            className="proto-btn proto-btn-secondary"
            style={{ fontSize: 12, padding: "4px 10px" }}
          >
            <Database size={13} />
            Ingest
            <ChevronDown size={11} />
          </button>
        </div>
      </div>

      {/* Editor */}
      <div className="flex-1 min-h-0">
        <NoteEditor filePath={rawPath} onSave={handleSave} />
      </div>

      {/* Ingest Dialog */}
      {showIngest && (
        <IngestDialog
          rawPath={rawPath}
          notePath={notePath}
          ingestBusy={ingestBusy}
          ingestSteps={ingestSteps}
          ingestResult={ingestResult}
          onClose={() => setShowIngest(false)}
          onIngestComplete={onIngestComplete}
        />
      )}
    </div>
  );
}
