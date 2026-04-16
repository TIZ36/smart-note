import { Search, Settings, Loader2, FileEdit, BookOpen, Gauge, Brain } from "lucide-react";
import { cn } from "@/lib/cn";
import type { ChannelId } from "@/lib/types";

type Props = {
  activeChannel: ChannelId;
  onSelect: (channel: ChannelId) => void;
  gatewayOnline: boolean;
  ingestBusy: boolean;
  embeddingMode: string;
  wikiTopicCount?: number;
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

export function Sidebar({ activeChannel, onSelect, gatewayOnline, ingestBusy, embeddingMode, wikiTopicCount = 0 }: Props) {
  return (
    <div className="proto-sidebar">
      <div className="proto-sidebar-logo" style={{ WebkitAppRegion: "drag" } as React.CSSProperties}>
        <span className="proto-logo-s">S</span><span className="proto-logo-n">N</span>
        <span className="proto-logo-particles" aria-hidden="true" />
      </div>

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
          label="Source"
          icon={<BookOpen size={15} strokeWidth={2} />}
          active={activeChannel === "source-list"}
          onClick={() => onSelect("source-list")}
          trailing={wikiTopicCount > 0 ? <span className="proto-nav-badge">{wikiTopicCount}</span> : undefined}
        />

      </div>

      <div className="proto-sidebar-footer">
        <NavItem label="Dashboard" icon={<Gauge size={15} strokeWidth={2} />} active={activeChannel === "dashboard"} onClick={() => onSelect("dashboard")} />
        <NavItem label="Meta-memory" icon={<Brain size={15} strokeWidth={2} />} active={activeChannel === "meta-memory"} onClick={() => onSelect("meta-memory")} />
        <NavItem label="Settings" icon={<Settings size={15} strokeWidth={2} />} active={activeChannel === "settings"} onClick={() => onSelect("settings")} />
        <div className="proto-sidebar-status">
          <span className={cn("proto-status-dot", !gatewayOnline && "proto-status-dot-offline")} />
          {gatewayOnline ? "Online" : "Offline"} · {embeddingMode || "local"}
        </div>
      </div>
    </div>
  );
}
