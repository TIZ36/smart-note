import { Search, Settings, Loader2, FileEdit, BookOpen, FileText } from "lucide-react";
import { cn } from "@/lib/cn";
import type { ChannelId } from "@/lib/types";
import type { WikiSource } from "@/lib/api";

type Props = {
  activeChannel: ChannelId;
  onSelect: (channel: ChannelId) => void;
  gatewayOnline: boolean;
  ingestBusy: boolean;
  embeddingMode: string;
  wikiTopicCount?: number;
  wikiSources?: WikiSource[];
};

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="proto-section-label">
      <span>{children}</span>
    </div>
  );
}

function NavItem({
  label, icon, active, onClick, trailing,
}: {
  label: string; icon: React.ReactNode; active: boolean;
  onClick: () => void; trailing?: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn("proto-nav-item", active && "proto-nav-item-active")}
    >
      {icon}
      <span className="flex-1 truncate">{label}</span>
      {trailing}
    </button>
  );
}

export function Sidebar({ activeChannel, onSelect, gatewayOnline, ingestBusy, embeddingMode, wikiTopicCount = 0, wikiSources = [] }: Props) {
  return (
    <div className="proto-sidebar">
      <div className="h-12 shrink-0" style={{ WebkitAppRegion: "drag" } as React.CSSProperties} />

      <div className="proto-sidebar-nav">
        <NavItem label="Search" icon={<Search size={15} strokeWidth={2} />} active={activeChannel === "search"} onClick={() => onSelect("search")} />

        <SectionLabel>Notes</SectionLabel>
        <NavItem
          label="Editor"
          icon={<FileEdit size={15} strokeWidth={2} />}
          active={activeChannel === "note"}
          onClick={() => onSelect("note")}
          trailing={ingestBusy ? <Loader2 size={12} className="text-[var(--color-accent)] animate-spin ml-auto shrink-0" /> : undefined}
        />

        <SectionLabel>Wiki</SectionLabel>
        <NavItem
          label="Topics"
          icon={<BookOpen size={15} strokeWidth={2} />}
          active={activeChannel === "special-knowledge"}
          onClick={() => onSelect("special-knowledge")}
          trailing={wikiTopicCount > 0 ? <span className="proto-nav-badge">{wikiTopicCount}</span> : undefined}
        />

        {wikiSources.length > 0 && (
          <>
            <SectionLabel>Sources</SectionLabel>
            {wikiSources.map((s) => (
              <NavItem
                key={s.path}
                label={s.name}
                icon={<FileText size={15} strokeWidth={2} />}
                active={activeChannel === `source:${s.path}`}
                onClick={() => onSelect(`source:${s.path}`)}
              />
            ))}
          </>
        )}

      </div>

      <div className="proto-sidebar-footer">
        <NavItem label="Settings" icon={<Settings size={15} strokeWidth={2} />} active={activeChannel === "settings"} onClick={() => onSelect("settings")} />
        <div className="proto-sidebar-status">
          <span className={cn("proto-status-dot", !gatewayOnline && "proto-status-dot-offline")} />
          {gatewayOnline ? "Online" : "Offline"} · {embeddingMode || "local"}
        </div>
      </div>
    </div>
  );
}
