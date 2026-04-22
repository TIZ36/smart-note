import { useEffect, useState } from "react";
import { X, Sparkles, Filter, Eye, Loader2, CheckCircle2, Plus, Minus, ArrowRight } from "lucide-react";
import * as api from "@/lib/api";
import type { NoteView, ViewDisplay, ViewRule, PopulateDiff } from "@/lib/api";

type Props = {
  open: boolean;
  initial?: NoteView | null;        // null = create mode, NoteView = edit mode
  onClose: () => void;
  onSubmit: (data: {
    name: string;
    rule: ViewRule;
    display: ViewDisplay;
    runPopulate: boolean;
  }) => Promise<void> | void;
};

const DEFAULT_DISPLAY: ViewDisplay = {
  dim_level: "medium",
  dim_mode: "opacity",
  show_tags: true,
  show_ts: true,
  show_bookmarks: true,
  density: "comfortable",
};

/* Create/edit view dialog.
   Rule panel lets the user combine: comma-separated keywords, regex, and
   an AI semantic query. The "Save & populate" button persists the view
   then kicks off a backend populate pass. Display knobs are per-view and
   inherit from the app theme for colors. */
export function NoteViewDialog({ open, initial, onClose, onSubmit }: Props) {
  const [name, setName] = useState("");
  const [keywords, setKeywords] = useState("");
  const [regex, setRegex] = useState("");
  const [aiQuery, setAiQuery] = useState("");
  const [display, setDisplay] = useState<ViewDisplay>(DEFAULT_DISPLAY);
  const [submitting, setSubmitting] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [previewDiff, setPreviewDiff] = useState<PopulateDiff | null>(null);
  const [previewError, setPreviewError] = useState("");

  useEffect(() => {
    if (!open) return;
    setName(initial?.name || "");
    setKeywords((initial?.rule.keywords || []).join(", "));
    setRegex(initial?.rule.regex || "");
    setAiQuery(initial?.rule.ai_query || "");
    setDisplay({ ...DEFAULT_DISPLAY, ...(initial?.display || {}) });
    setSubmitting(false);
    setPreviewDiff(null);
    setPreviewError("");
  }, [open, initial]);

  // Dry-run against the currently edited rules. Only available when
  // editing an existing view — on create we don't have a view_id yet
  // to pass to populate. Rationale: showing the diff vs the previous
  // rule state is the whole value prop; on a fresh view everything
  // would be "added", which is less informative.
  const canPreview = Boolean(initial?.id);
  async function handlePreview() {
    if (!initial?.id || previewing) return;
    const rule: ViewRule = {
      keywords: keywords.split(/[,，\n]/).map((s) => s.trim()).filter(Boolean),
      regex: regex.trim() || undefined,
      ai_query: aiQuery.trim() || undefined,
    };
    setPreviewing(true);
    setPreviewError("");
    try {
      const r = await api.populateView(initial.id, { rule, replace: true, dry_run: true });
      if (r.diff) setPreviewDiff(r.diff);
    } catch (e) {
      setPreviewError(String(e));
    } finally {
      setPreviewing(false);
    }
  }

  if (!open) return null;

  const handleSubmit = async (runPopulate: boolean) => {
    if (!name.trim()) return;
    const rule: ViewRule = {
      keywords: keywords
        .split(/[,，\n]/)
        .map((s) => s.trim())
        .filter(Boolean),
      regex: regex.trim() || undefined,
      ai_query: aiQuery.trim() || undefined,
    };
    setSubmitting(true);
    try {
      await onSubmit({ name: name.trim(), rule, display, runPopulate });
    } finally {
      setSubmitting(false);
    }
  };

  const hasRule = keywords.trim() || regex.trim() || aiQuery.trim();

  return (
    <div
      className="proto-dialog-overlay"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="proto-dialog proto-view-dialog" role="dialog">
        <div className="proto-dialog-header">
          <span>{initial ? "Edit view" : "New view"}</span>
          <button type="button" className="proto-dialog-close" onClick={onClose} aria-label="Close">
            <X size={14} strokeWidth={2} />
          </button>
        </div>

        <div className="proto-dialog-body proto-view-dialog-body">
          <label className="proto-view-field">
            <span className="proto-view-field-label">Name</span>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Work log, Reading notes"
              className="proto-view-input"
              autoFocus
            />
          </label>

          <div className="proto-view-section">
            <div className="proto-view-section-head">
              <Filter size={12} strokeWidth={2} />
              <span>Rules (auto-populate)</span>
              <span className="proto-view-section-hint">Lines matching any rule are added</span>
            </div>

            <label className="proto-view-field">
              <span className="proto-view-field-sublabel">Keywords</span>
              <input
                type="text"
                value={keywords}
                onChange={(e) => setKeywords(e.target.value)}
                placeholder="comma-separated, case-insensitive"
                className="proto-view-input"
              />
            </label>

            <label className="proto-view-field">
              <span className="proto-view-field-sublabel">Regex</span>
              <input
                type="text"
                value={regex}
                onChange={(e) => setRegex(e.target.value)}
                placeholder="optional — Python regex, per line"
                className="proto-view-input proto-view-input-mono"
              />
            </label>

            <label className="proto-view-field">
              <span className="proto-view-field-sublabel">
                <Sparkles size={11} strokeWidth={2} /> AI semantic query
              </span>
              <textarea
                value={aiQuery}
                onChange={(e) => setAiQuery(e.target.value)}
                placeholder="optional — a natural-language description of the topic; matches via the retrieval index"
                className="proto-view-textarea"
                rows={2}
              />
            </label>
          </div>

          <div className="proto-view-section">
            <div className="proto-view-section-head">
              <span>Display</span>
              <span className="proto-view-section-hint">Colors follow the app theme</span>
            </div>

            <div className="proto-view-knobs">
              <KnobSelect
                label="Dim"
                value={display.dim_level || "medium"}
                options={[["light", "Light"], ["medium", "Medium"], ["heavy", "Heavy"]]}
                onChange={(v) => setDisplay((d) => ({ ...d, dim_level: v as ViewDisplay["dim_level"] }))}
              />
              <KnobSelect
                label="Style"
                value={display.dim_mode || "opacity"}
                options={[["opacity", "Fade"], ["frost", "Frost"]]}
                onChange={(v) => setDisplay((d) => ({ ...d, dim_mode: v as ViewDisplay["dim_mode"] }))}
              />
              <KnobSelect
                label="Density"
                value={display.density || "comfortable"}
                options={[["comfortable", "Comfortable"], ["compact", "Compact"]]}
                onChange={(v) => setDisplay((d) => ({ ...d, density: v as ViewDisplay["density"] }))}
              />
            </div>

            <div className="proto-view-toggles">
              <KnobToggle
                label="Tags strip"
                checked={display.show_tags !== false}
                onChange={(v) => setDisplay((d) => ({ ...d, show_tags: v }))}
              />
              <KnobToggle
                label="Timestamps"
                checked={display.show_ts !== false}
                onChange={(v) => setDisplay((d) => ({ ...d, show_ts: v }))}
              />
              <KnobToggle
                label="Bookmarks"
                checked={display.show_bookmarks !== false}
                onChange={(v) => setDisplay((d) => ({ ...d, show_bookmarks: v }))}
              />
            </div>
          </div>
        </div>

        {/* Dry-run diff panel — before/after preview without committing. */}
        {(previewDiff || previewError) && (
          <div className="proto-view-diff">
            {previewError && (
              <div className="proto-settings-status proto-settings-status-error">
                {previewError}
              </div>
            )}
            {previewDiff && (
              <>
                <div className="proto-view-diff-head">
                  <span>Preview (nothing saved yet)</span>
                  <span className="proto-view-diff-summary">
                    +{previewDiff.added.length} new · -{previewDiff.removed.length} removed
                    {previewDiff.source_changed.length > 0 && ` · ${previewDiff.source_changed.length} source changes`}
                    · {previewDiff.unchanged_count} unchanged
                  </span>
                </div>
                {previewDiff.added.length > 0 && (
                  <div className="proto-view-diff-section proto-view-diff-section-added">
                    <div className="proto-view-diff-section-label"><Plus size={11} /> added</div>
                    {previewDiff.added.slice(0, 15).map((d) => (
                      <div key={d.line_hash} className="proto-view-diff-row">
                        <span className="proto-view-diff-src">{d.source}</span>
                        <span className="proto-view-diff-text">{d.preview}</span>
                      </div>
                    ))}
                    {previewDiff.added.length > 15 && (
                      <div className="proto-view-diff-more">… and {previewDiff.added.length - 15} more</div>
                    )}
                  </div>
                )}
                {previewDiff.removed.length > 0 && (
                  <div className="proto-view-diff-section proto-view-diff-section-removed">
                    <div className="proto-view-diff-section-label"><Minus size={11} /> removed</div>
                    {previewDiff.removed.slice(0, 15).map((d) => (
                      <div key={d.line_hash} className="proto-view-diff-row">
                        <span className="proto-view-diff-src">{d.source}</span>
                        <span className="proto-view-diff-text">{d.preview}</span>
                      </div>
                    ))}
                    {previewDiff.removed.length > 15 && (
                      <div className="proto-view-diff-more">… and {previewDiff.removed.length - 15} more</div>
                    )}
                  </div>
                )}
                {previewDiff.source_changed.length > 0 && (
                  <div className="proto-view-diff-section proto-view-diff-section-changed">
                    <div className="proto-view-diff-section-label"><ArrowRight size={11} /> source changed</div>
                    {previewDiff.source_changed.slice(0, 10).map((d) => (
                      <div key={d.line_hash} className="proto-view-diff-row">
                        <span className="proto-view-diff-src">{d.from} → {d.to}</span>
                        <span className="proto-view-diff-text">{d.preview}</span>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        )}

        <div className="proto-view-dialog-footer">
          <button type="button" className="proto-btn" onClick={onClose} disabled={submitting}>
            Cancel
          </button>
          {canPreview && hasRule && (
            <button
              type="button"
              className="proto-btn"
              onClick={handlePreview}
              disabled={previewing || submitting}
              title="Run rules in dry-run mode — see what would change without saving"
            >
              {previewing ? <Loader2 size={13} className="animate-spin" /> : <Eye size={13} />}
              {previewing ? "Previewing…" : "Preview"}
            </button>
          )}
          <button
            type="button"
            className="proto-btn"
            onClick={() => handleSubmit(false)}
            disabled={submitting || !name.trim()}
          >
            Save
          </button>
          <button
            type="button"
            className={previewDiff ? "proto-btn proto-btn-primary" : "proto-btn proto-btn-primary"}
            onClick={() => handleSubmit(true)}
            disabled={submitting || !name.trim() || !hasRule}
            title={hasRule ? "Save and run rules against the file" : "Add at least one rule to populate"}
          >
            {previewDiff ? <CheckCircle2 size={13} /> : <Sparkles size={13} />}
            {previewDiff ? "Apply changes" : "Save & populate"}
          </button>
        </div>
      </div>
    </div>
  );
}

function KnobSelect({
  label, value, options, onChange,
}: {
  label: string;
  value: string;
  options: [string, string][];
  onChange: (v: string) => void;
}) {
  return (
    <label className="proto-view-knob">
      <span>{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
    </label>
  );
}

function KnobToggle({
  label, checked, onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="proto-view-toggle">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span>{label}</span>
    </label>
  );
}
