import { useState } from "react";
import { CloudSyncPage } from "../cloud-sync/CloudSyncPage";
import { DraftInbox } from "../cloud-sync/DraftInbox";
import { OverviewTab } from "./tabs/OverviewTab";
import { DevicesTab } from "./tabs/DevicesTab";
import { EnrichTab } from "./tabs/EnrichTab";
import { cn } from "@/lib/cn";

/* Cloud Console — multi-tab management surface. Sync becomes one tab
   among Overview / Devices / Enrich / Sync / Memories rather than the
   whole page. Polished to match the proto-* design system. */

const TABS = ["overview", "devices", "enrich", "sync", "memories"] as const;
type Tab = (typeof TABS)[number];

const LABELS: Record<Tab, string> = {
  overview: "Overview",
  devices: "Devices",
  enrich: "Enrich",
  sync: "Sync",
  memories: "Memories",
};

export function CloudConsolePage() {
  const [tab, setTab] = useState<Tab>("overview");

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="proto-results-topbar shrink-0">
        <div className="proto-results-topbar-row" style={{ gap: 2 }}>
          {TABS.map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={cn("proto-cc-tab", tab === t && "proto-cc-tab-active")}
            >
              {LABELS[t]}
            </button>
          ))}
        </div>
      </div>
      <div className="flex-1 overflow-y-auto">
        {tab === "overview" && <OverviewTab />}
        {tab === "devices" && <DevicesTab />}
        {tab === "enrich" && <EnrichTab />}
        {tab === "sync" && <CloudSyncPage />}
        {tab === "memories" && (
          <div className="proto-cc-content">
            <DraftInbox hasConfig={true} />
          </div>
        )}
      </div>
    </div>
  );
}
