import { useRef, useEffect } from "react";
import { Search, Loader2 } from "lucide-react";

type Props = {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  onTab?: () => void;
  loading?: boolean;
  tagFilter?: string | null;
};

export function SearchBar({ value, onChange, onSubmit, onTab, loading, tagFilter }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  return (
    <div className="proto-search-input-wrap">
      {loading ? (
        <Loader2 size={16} className="text-[var(--color-accent)] animate-spin shrink-0" />
      ) : (
        <Search size={16} className="shrink-0 text-[var(--color-text-muted)]" strokeWidth={2} />
      )}
      {tagFilter && (
        <span className="proto-search-tag-chip">{tagFilter}</span>
      )}
      <input
        ref={inputRef}
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") { e.preventDefault(); onSubmit(); }
          if (e.key === "Tab" && onTab) { e.preventDefault(); onTab(); }
        }}
        placeholder={tagFilter ? `Search in ${tagFilter}...` : "Search your notes..."}
        className="proto-search-input"
      />
      {value && !loading && (
        <span className="text-[11px] text-[var(--color-text-muted)]/60 select-none shrink-0">Enter ↵</span>
      )}
    </div>
  );
}
