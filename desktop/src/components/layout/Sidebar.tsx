import { Search, Settings, Loader2, FileEdit, BookOpen, Files, Inbox, Zap } from "lucide-react";
import { cn } from "@/lib/cn";
import type { ChannelId } from "@/lib/types";

type Props = {
  activeChannel: ChannelId;
  onSelect: (channel: ChannelId) => void;
  ingestBusy: boolean;
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
  label, icon, active, onClick, trailing, sub, sectionStart,
}: {
  label: string; icon: React.ReactNode; active: boolean;
  onClick: () => void; trailing?: React.ReactNode;
  sub?: boolean; sectionStart?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "proto-nav-item",
        sub && "proto-nav-subitem",
        sectionStart && "proto-nav-section-start",
        active && "proto-nav-item-active",
      )}
    >
      {icon}
      <span className="flex-1 truncate">{label}</span>
      {trailing}
    </button>
  );
}

export function Sidebar({ activeChannel, onSelect, ingestBusy, wikiTopicCount = 0 }: Props) {
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
          label="Note"
          icon={<FileEdit size={15} strokeWidth={2} />}
          active={activeChannel === "note"}
          onClick={() => onSelect("note")}
          trailing={ingestBusy ? <Loader2 size={12} className="text-[var(--color-accent)] animate-spin ml-auto shrink-0" /> : undefined}
        />

        <NavItem
          label="Wiki"
          icon={<BookOpen size={15} strokeWidth={2} />}
          active={activeChannel === "special-knowledge"}
          onClick={() => onSelect("special-knowledge")}
          trailing={wikiTopicCount > 0 ? <span className="proto-nav-badge">{wikiTopicCount}</span> : undefined}
          sectionStart
        />
        <NavItem
          label="Source"
          icon={<Files size={13} strokeWidth={2} />}
          active={activeChannel === "source-list"}
          onClick={() => onSelect("source-list")}
          sub
        />

      </div>

      <div className="proto-sidebar-footer">
        <NavItem label="Skills" icon={<Zap size={15} strokeWidth={2} />} active={activeChannel === "skills"} onClick={() => onSelect("skills")} />
        <NavItem label="Insights" icon={<Inbox size={15} strokeWidth={2} />} active={activeChannel === "insights" || activeChannel === "dashboard" || activeChannel === "meta-memory"} onClick={() => onSelect("insights")} />
        <NavItem label="Settings" icon={<Settings size={15} strokeWidth={2} />} active={activeChannel === "settings"} onClick={() => onSelect("settings")} />
      </div>
    </div>
  );
}
