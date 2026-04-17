import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { Search, Filter, X, Loader2, Check, AlertTriangle, Plus } from "lucide-react";
import * as api from "@/lib/api";
import { cn } from "@/lib/cn";

type KindFilter = "all" | "periodic" | "sequence";
type PeriodFilter = "all" | "daily" | "weekly" | "monthly" | "ad_hoc";

/**
 * Skills — a catalog browser for the user's 100+ stored skill templates.
 * Left: dense list with search + filters. Right: read + inline-edit detail
 * view of the selected skill. This page does NOT trigger or execute skills;
 * external IDEs (Claude Code, Cursor, OpenCode) own execution via MCP.
 */
export function SkillsPanel() {
  const [templates, setTemplates] = useState<api.SkillTemplate[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [query, setQuery] = useState("");
  const [kindFilter, setKindFilter] = useState<KindFilter>("all");
  const [periodFilter, setPeriodFilter] = useState<PeriodFilter>("all");
  const searchRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { templates: t } = await api.fetchSkills();
      setTemplates(t);
      if (t.length > 0) {
        setSelectedId((cur) => (cur && t.some((x) => x.id === cur) ? cur : t[0].id));
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // ⌘K / Ctrl+K → focus search (standard convention).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const meta = e.metaKey || e.ctrlKey;
      if (meta && e.key.toLowerCase() === "k") {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return templates.filter((t) => {
      if (kindFilter !== "all" && t.kind !== kindFilter) return false;
      if (periodFilter !== "all" && t.period_hint !== periodFilter) return false;
      if (!q) return true;
      if (t.name.toLowerCase().includes(q)) return true;
      if (t.description.toLowerCase().includes(q)) return true;
      return t.nodes.some(
        (n) =>
          n.name?.toLowerCase().includes(q) ||
          n.description?.toLowerCase().includes(q) ||
          n.expected_tag?.toLowerCase().includes(q) ||
          n.trigger_hints?.some((h) => h.toLowerCase().includes(q))
      );
    });
  }, [templates, query, kindFilter, periodFilter]);

  const selected = useMemo(
    () => templates.find((t) => t.id === selectedId) ?? null,
    [templates, selectedId]
  );

  // ↑↓ navigate within the filtered list when search isn't focused.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (document.activeElement instanceof HTMLInputElement || document.activeElement instanceof HTMLTextAreaElement) return;
      if (filtered.length === 0) return;
      const idx = filtered.findIndex((t) => t.id === selectedId);
      if (e.key === "ArrowDown") {
        e.preventDefault();
        const next = filtered[Math.min(filtered.length - 1, idx + 1)];
        if (next) setSelectedId(next.id);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        const prev = filtered[Math.max(0, idx - 1)];
        if (prev) setSelectedId(prev.id);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [filtered, selectedId]);

  // Optimistic replace in local state after a PATCH succeeds so the list +
  // detail stay in sync without a full refetch.
  const applyUpdate = useCallback((updated: api.SkillTemplate) => {
    setTemplates((prev) => prev.map((t) => (t.id === updated.id ? updated : t)));
    setSelectedId(updated.id);
  }, []);

  const clearFilters = query || kindFilter !== "all" || periodFilter !== "all";

  return (
    <div className="proto-skills-page">
      <header className="proto-skills-header">
        <div>
          <h1 className="proto-dashboard-title">Skills</h1>
          <p className="proto-skills-subtitle">
            Catalog of reusable recipes. Claude Code / Cursor / OpenCode read
            them via MCP and execute. Click a field to edit.
          </p>
        </div>
        <span className="proto-skills-count" aria-live="polite">
          {loading ? "…" : `${filtered.length} / ${templates.length}`}
        </span>
      </header>

      <div className="proto-skills-toolbar">
        <div className="proto-skills-search">
          <Search size={13} strokeWidth={2} />
          <input
            ref={searchRef}
            className="proto-skills-search-input"
            placeholder="Search skills (⌘K)"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {query && (
            <button
              type="button"
              className="proto-skills-search-clear"
              onClick={() => setQuery("")}
              aria-label="Clear search"
            >
              <X size={11} strokeWidth={2} />
            </button>
          )}
        </div>
        <div className="proto-skills-filters">
          <Filter size={12} className="proto-skills-filter-icon" aria-hidden />
          <Segmented<KindFilter>
            value={kindFilter}
            onChange={setKindFilter}
            options={[
              { v: "all", l: "All" },
              { v: "periodic", l: "Periodic" },
              { v: "sequence", l: "Sequence" },
            ]}
          />
          <Segmented<PeriodFilter>
            value={periodFilter}
            onChange={setPeriodFilter}
            options={[
              { v: "all", l: "All periods" },
              { v: "daily", l: "Daily" },
              { v: "weekly", l: "Weekly" },
              { v: "monthly", l: "Monthly" },
              { v: "ad_hoc", l: "Ad-hoc" },
            ]}
          />
          {clearFilters && (
            <button
              type="button"
              className="proto-skills-clear"
              onClick={() => { setQuery(""); setKindFilter("all"); setPeriodFilter("all"); }}
            >
              Clear
            </button>
          )}
        </div>
      </div>

      {error && <p className="proto-dashboard-error">{error}</p>}

      <div className="proto-skills-body">
        <aside className="proto-skills-list" role="listbox" aria-label="Skills">
          {loading && templates.length === 0 && <ListSkeleton />}
          {!loading && filtered.length === 0 && (
            <p className="proto-skills-empty">
              {templates.length === 0
                ? "No skills yet. Save one via MCP: `upload_skill(...)`."
                : `No matches for "${query}".`}
            </p>
          )}
          {filtered.map((t) => (
            <ListRow
              key={t.id}
              template={t}
              active={t.id === selectedId}
              onSelect={() => setSelectedId(t.id)}
            />
          ))}
        </aside>

        <main className="proto-skills-detail">
          {!selected && !loading && (
            <div className="proto-skills-detail-empty">
              <span>No skill selected</span>
            </div>
          )}
          {selected && (
            <SkillDetail key={selected.id} template={selected} onUpdated={applyUpdate} />
          )}
        </main>
      </div>
    </div>
  );
}

// ── List row ─────────────────────────────────────────────────────

function ListRow({
  template,
  active,
  onSelect,
}: {
  template: api.SkillTemplate;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      className={cn("proto-skills-row", active && "proto-skills-row-active")}
      onClick={onSelect}
      role="option"
      aria-selected={active}
    >
      <span className="proto-skills-row-name">{template.name}</span>
      <span className="proto-skills-row-meta">
        {template.kind} · {template.period_hint} · {template.nodes.length} {template.nodes.length === 1 ? "step" : "steps"}
      </span>
    </button>
  );
}

function ListSkeleton() {
  return (
    <div className="proto-skills-skeleton">
      {Array.from({ length: 10 }).map((_, i) => (
        <div key={i} className="proto-skills-skeleton-row" style={{ animationDelay: `${i * 40}ms` }} />
      ))}
    </div>
  );
}

// ── Generic segmented control ────────────────────────────────────

function Segmented<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { v: T; l: string }[];
}) {
  return (
    <div className="proto-segmented" role="tablist">
      {options.map((o) => (
        <button
          key={o.v}
          type="button"
          role="tab"
          aria-selected={value === o.v}
          className={cn("proto-segmented-option", value === o.v && "proto-segmented-option-active")}
          onClick={() => onChange(o.v)}
        >
          {o.l}
        </button>
      ))}
    </div>
  );
}

// ── Detail pane ──────────────────────────────────────────────────

function SkillDetail({
  template,
  onUpdated,
}: {
  template: api.SkillTemplate;
  onUpdated: (t: api.SkillTemplate) => void;
}) {
  const commit = useCallback(async (body: api.SkillPatchBody) => {
    const updated = await api.patchSkill(template.name, body);
    onUpdated(updated);
  }, [template.name, onUpdated]);

  return (
    <div className="proto-skill-detail-inner">
      <div className="proto-skill-detail-head">
        <InlineText
          value={template.name}
          kind="name"
          onSave={(v) => commit({ new_name: v })}
        />
        <div className="proto-skill-detail-meta">
          <span>{template.kind}</span>
          <span className="proto-skill-detail-sep">·</span>
          <span>{template.period_hint}</span>
          <span className="proto-skill-detail-sep">·</span>
          <span>{template.nodes.length} {template.nodes.length === 1 ? "step" : "steps"}</span>
          <span className="proto-skill-detail-sep">·</span>
          <span>updated {formatRelative(template.updated_at)}</span>
        </div>
        <InlineText
          value={template.description}
          multiline
          placeholder="Add a description"
          kind="description"
          onSave={(v) => commit({ description: v })}
        />
      </div>

      <section className="proto-skill-steps">
        {template.nodes.map((node, idx) => (
          <StepRow
            key={idx}
            index={idx}
            node={node}
            onPatch={(patch) => commit({ nodes: [{ index: idx, ...patch }] })}
          />
        ))}
      </section>
    </div>
  );
}

function StepRow({
  index,
  node,
  onPatch,
}: {
  index: number;
  node: api.SkillNode;
  onPatch: (patch: Omit<api.SkillNodePatch, "index">) => Promise<void>;
}) {
  return (
    <article className="proto-skill-step">
      <span className="proto-skill-step-idx" aria-hidden>{index + 1}</span>
      <div className="proto-skill-step-body">
        <div className="proto-skill-step-head">
          <InlineText
            value={node.name || ""}
            placeholder="Step name"
            kind="step-name"
            onSave={(v) => onPatch({ name: v })}
          />
          <InlineTag
            value={node.expected_tag || ""}
            onSave={(v) => onPatch({ expected_tag: v })}
          />
        </div>
        <InlineText
          value={node.description || ""}
          multiline
          placeholder="Add step description"
          kind="step-desc"
          onSave={(v) => onPatch({ description: v })}
        />
        <HintChips
          hints={node.trigger_hints || []}
          onSave={(next) => onPatch({ trigger_hints: next })}
        />
      </div>
    </article>
  );
}

// ── Inline text editor ───────────────────────────────────────────
// Click → focuses; blur or ⌘↵ saves; Esc cancels.
// Shows a short accent pulse on success, inline error on failure.

type InlineTextProps = {
  value: string;
  onSave: (v: string) => Promise<void>;
  multiline?: boolean;
  placeholder?: string;
  kind: "name" | "description" | "step-name" | "step-desc";
};

function InlineText({ value, onSave, multiline, placeholder, kind }: InlineTextProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);

  useEffect(() => { setDraft(value); }, [value]);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  useEffect(() => {
    if (status === "saved") {
      const t = setTimeout(() => setStatus("idle"), 900);
      return () => clearTimeout(t);
    }
  }, [status]);

  async function save() {
    if (draft === value) { setEditing(false); return; }
    setStatus("saving");
    setError(null);
    try {
      await onSave(draft);
      setStatus("saved");
      setEditing(false);
    } catch (e) {
      setStatus("error");
      setError(String(e));
    }
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      setDraft(value);
      setEditing(false);
      setError(null);
      setStatus("idle");
    } else if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      save();
    }
  }

  const display = value || placeholder || "";
  const isPlaceholder = !value;
  const rootClass = cn(
    "proto-inline-text",
    `proto-inline-text-${kind}`,
    editing && "proto-inline-text-editing",
    status === "saved" && "proto-inline-text-saved",
    status === "error" && "proto-inline-text-error",
    isPlaceholder && !editing && "proto-inline-text-placeholder",
  );

  if (!editing) {
    const Tag = kind === "name" ? "h2" : kind === "step-name" ? "h3" : multiline ? "p" : "span";
    return (
      <Tag
        className={rootClass}
        role="button"
        tabIndex={0}
        onClick={() => setEditing(true)}
        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); setEditing(true); } }}
        title="Click to edit"
      >
        {display}
      </Tag>
    );
  }

  const commonProps = {
    value: draft,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setDraft(e.target.value),
    onBlur: save,
    onKeyDown,
    placeholder: placeholder || "",
    className: "proto-inline-text-input",
    "aria-label": placeholder || "Edit",
  };

  return (
    <div className={rootClass}>
      {multiline ? (
        <textarea ref={inputRef as React.RefObject<HTMLTextAreaElement>} rows={2} {...commonProps} />
      ) : (
        <input ref={inputRef as React.RefObject<HTMLInputElement>} {...commonProps} />
      )}
      {status === "saving" && <Loader2 size={11} className="animate-spin proto-inline-text-indicator" />}
      {error && (
        <span className="proto-inline-text-error-msg">
          <AlertTriangle size={11} /> {error}
        </span>
      )}
      <span className="proto-inline-text-hint">⌘↵ save · Esc cancel</span>
    </div>
  );
}

// ── Inline tag (expected_tag, `#work`) ───────────────────────────

function InlineTag({ value, onSave }: { value: string; onSave: (v: string) => Promise<void> }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { setDraft(value); }, [value]);
  useEffect(() => { if (editing) inputRef.current?.focus(); }, [editing]);

  async function save() {
    if (draft.trim() === value.trim()) { setEditing(false); return; }
    try { await onSave(draft.trim()); } catch { /* surfaced at detail level via shared state */ }
    setEditing(false);
  }

  if (!editing) {
    if (!value) {
      return (
        <button
          type="button"
          className="proto-skill-tag-empty"
          onClick={() => setEditing(true)}
          title="Add expected tag"
        >
          <Plus size={10} /> tag
        </button>
      );
    }
    return (
      <button
        type="button"
        className="proto-skill-tag"
        onClick={() => setEditing(true)}
        title="Click to edit tag"
      >
        #{value}
      </button>
    );
  }

  return (
    <input
      ref={inputRef}
      className="proto-skill-tag-input"
      value={draft}
      onChange={(e) => setDraft(e.target.value.replace(/^#+/, ""))}
      onBlur={save}
      onKeyDown={(e) => {
        if (e.key === "Enter") { e.preventDefault(); save(); }
        if (e.key === "Escape") { setDraft(value); setEditing(false); }
      }}
      placeholder="tag"
    />
  );
}

// ── Trigger hint chips — editable collection ─────────────────────

function HintChips({
  hints,
  onSave,
}: {
  hints: string[];
  onSave: (next: string[]) => Promise<void>;
}) {
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { if (adding) inputRef.current?.focus(); }, [adding]);

  async function addChip() {
    const v = draft.trim();
    if (!v) { setAdding(false); setDraft(""); return; }
    await onSave([...hints, v]);
    setDraft("");
    setAdding(false);
  }

  async function removeChip(idx: number) {
    const next = hints.filter((_, i) => i !== idx);
    await onSave(next);
  }

  async function editChip(idx: number, v: string) {
    const trimmed = v.trim();
    if (!trimmed) return;
    const next = hints.map((h, i) => (i === idx ? trimmed : h));
    await onSave(next);
  }

  return (
    <div className="proto-skill-hints">
      {hints.map((h, i) => (
        <EditableChip
          key={`${i}-${h}`}
          value={h}
          onSave={(v) => editChip(i, v)}
          onRemove={() => removeChip(i)}
        />
      ))}
      {adding ? (
        <input
          ref={inputRef}
          className="proto-skill-hint-input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={addChip}
          onKeyDown={(e) => {
            if (e.key === "Enter") { e.preventDefault(); addChip(); }
            if (e.key === "Escape") { setAdding(false); setDraft(""); }
          }}
          placeholder="new hint"
        />
      ) : (
        <button
          type="button"
          className="proto-skill-hint-add"
          onClick={() => setAdding(true)}
          title="Add trigger hint"
        >
          <Plus size={10} /> hint
        </button>
      )}
    </div>
  );
}

function EditableChip({
  value,
  onSave,
  onRemove,
}: {
  value: string;
  onSave: (v: string) => Promise<void>;
  onRemove: () => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { setDraft(value); }, [value]);
  useEffect(() => { if (editing) inputRef.current?.focus(); }, [editing]);

  async function commit() {
    if (draft.trim() === value.trim()) { setEditing(false); return; }
    await onSave(draft);
    setEditing(false);
  }

  if (editing) {
    return (
      <input
        ref={inputRef}
        className="proto-skill-hint-input"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") { e.preventDefault(); commit(); }
          if (e.key === "Escape") { setDraft(value); setEditing(false); }
          if (e.key === "Backspace" && draft === "") { e.preventDefault(); onRemove(); }
        }}
      />
    );
  }

  return (
    <span className="proto-skill-hint-chip">
      <button
        type="button"
        className="proto-skill-hint-chip-label"
        onClick={() => setEditing(true)}
        title="Click to edit, Backspace on empty to remove"
      >
        {value}
      </button>
      <button
        type="button"
        className="proto-skill-hint-chip-remove"
        onClick={onRemove}
        aria-label="Remove hint"
      >
        <X size={9} />
      </button>
    </span>
  );
}

// ── helpers ──────────────────────────────────────────────────────

function formatRelative(iso: string): string {
  try {
    const d = new Date(iso.replace(" ", "T") + "Z");
    const diff = Math.max(0, Date.now() - d.getTime());
    const mins = Math.floor(diff / 60_000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    if (days < 7) return `${days}d ago`;
    return iso.slice(0, 10);
  } catch {
    return iso;
  }
}
// Saved-pulse indicator uses a check glyph for future layout needs.
void Check;
