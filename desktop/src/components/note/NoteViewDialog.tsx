import { useEffect, useState } from "react";
import { X, Sparkles, Filter } from "lucide-react";
import type { NoteView, ViewDisplay, ViewRule } from "@/lib/api";

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

  useEffect(() => {
    if (!open) return;
    setName(initial?.name || "");
    setKeywords((initial?.rule.keywords || []).join(", "));
    setRegex(initial?.rule.regex || "");
    setAiQuery(initial?.rule.ai_query || "");
    setDisplay({ ...DEFAULT_DISPLAY, ...(initial?.display || {}) });
    setSubmitting(false);
  }, [open, initial]);

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

        <div className="proto-view-dialog-footer">
          <button type="button" className="proto-btn" onClick={onClose} disabled={submitting}>
            Cancel
          </button>
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
            className="proto-btn proto-btn-primary"
            onClick={() => handleSubmit(true)}
            disabled={submitting || !name.trim() || !hasRule}
            title={hasRule ? "Save and run rules against the file" : "Add at least one rule to populate"}
          >
            Save & populate
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
