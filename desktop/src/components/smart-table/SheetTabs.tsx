import type { SmartSheetSummary } from "@/lib/api";
import { cn } from "@/lib/cn";

type Props = {
  sheets: SmartSheetSummary[];
  activeSheet: string | null;
  onSelect: (name: string) => void;
};

export function SheetTabs({ sheets, activeSheet, onSelect }: Props) {
  return (
    <div className="proto-smart-table-tabs" role="tablist" aria-label="Sheets">
      {sheets.map((sheet) => (
        <button
          key={sheet.id}
          type="button"
          role="tab"
          aria-selected={sheet.name === activeSheet}
          className={cn(
            "proto-smart-table-tab",
            sheet.name === activeSheet && "proto-smart-table-tab-active"
          )}
          onClick={() => onSelect(sheet.name)}
        >
          <span className="truncate proto-smart-table-tab-label">{sheet.name}</span>
          <span className="proto-smart-table-tab-meta">{sheet.row_count}</span>
        </button>
      ))}
    </div>
  );
}
