import { useRef, useEffect, useState } from "react";
import { Search, Loader2, X } from "lucide-react";
import { cn } from "../../lib/cn";

type Props = {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  onTab?: () => void;
  loading?: boolean;
  tagFilter?: string | null;
  // Special knowledge @mentions
  selectedWiki?: string[];
  availableWiki?: string[];
  onWikiToggle?: (topic: string) => void;
};

export function SearchBar({ value, onChange, onSubmit, onTab, loading, tagFilter, selectedWiki = [], availableWiki = [], onWikiToggle }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [showDropdown, setShowDropdown] = useState(false);
  const [atQuery, setAtQuery] = useState("");

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  function handleChange(raw: string) {
    // Detect @ at end of input
    const atMatch = raw.match(/@(\S*)$/);
    if (atMatch && availableWiki.length > 0) {
      setAtQuery(atMatch[1].toLowerCase());
      setShowDropdown(true);
    } else {
      setShowDropdown(false);
      setAtQuery("");
    }
    onChange(raw);
  }

  function handleSelectWiki(topic: string) {
    onWikiToggle?.(topic);
    // Remove the @partial from the input
    const cleaned = value.replace(/@\S*$/, "").trim();
    onChange(cleaned);
    setShowDropdown(false);
    inputRef.current?.focus();
  }

  function handleRemoveWiki(topic: string) {
    onWikiToggle?.(topic);
  }

  const filteredWiki = availableWiki.filter(
    (s) => !selectedWiki.includes(s) && s.toLowerCase().includes(atQuery)
  );

  return (
    <div style={{ position: "relative" }}>
      <div className="proto-search-input-wrap">
        {loading ? (
          <Loader2 size={16} className="text-[var(--color-accent)] animate-spin shrink-0" />
        ) : (
          <Search size={16} className="shrink-0 text-[var(--color-text-muted)]" strokeWidth={2} />
        )}
        {tagFilter && (
          <span className="proto-search-tag-chip">{tagFilter}</span>
        )}
        {/* Selected wiki chips */}
        {selectedWiki.map((s) => (
          <span key={s} className="proto-wiki-chip">
            @{s}
            <button type="button" onClick={() => handleRemoveWiki(s)} className="proto-wiki-chip-remove">
              <X size={10} />
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
          type="text"
          value={value}
          onChange={(e) => handleChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") { e.preventDefault(); setShowDropdown(false); onSubmit(); }
            if (e.key === "Tab" && onTab) { e.preventDefault(); onTab(); }
            if (e.key === "Escape") setShowDropdown(false);
          }}
          onBlur={() => setTimeout(() => setShowDropdown(false), 200)}
          placeholder={tagFilter ? `Search in ${tagFilter}...` : selectedWiki.length > 0 ? `Search in @${selectedWiki[0]}...` : "Search notes & knowledge... (@ to focus wiki)"}
          className="proto-search-input"
        />
        {value && !loading && (
          <span className="text-[11px] text-[var(--color-text-muted)]/60 select-none shrink-0">Enter ↵</span>
        )}
      </div>

      {/* @ dropdown */}
      {showDropdown && filteredWiki.length > 0 && (
        <div className="proto-wiki-dropdown">
          <div className="proto-wiki-dropdown-label">Wiki</div>
          {filteredWiki.map((s) => (
            <button key={s} type="button" className="proto-wiki-dropdown-item" onMouseDown={(e) => { e.preventDefault(); handleSelectWiki(s); }}>
              <span className={cn("proto-tag-dot", "proto-tag-dot-purple")} />
              @{s}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
