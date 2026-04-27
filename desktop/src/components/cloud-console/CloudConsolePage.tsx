import { useState } from "react";
import { CloudSyncPage } from "../cloud-sync/CloudSyncPage";
import { DraftInbox } from "../cloud-sync/DraftInbox";
import { OverviewTab } from "./tabs/OverviewTab";
import { DevicesTab } from "./tabs/DevicesTab";
import { EnrichTab } from "./tabs/EnrichTab";

/* Cloud Console — multi-tab management surface. Sync becomes one tab
   among Overview / Devices / Enrich / Sync / Memories rather than the
   whole page. */

const TABS = ["overview", "devices", "enrich", "sync", "memories"] as const;
type Tab = (typeof TABS)[number];

const LABELS: Record<Tab, string> = {
  overview: "Overview", devices: "Devices", enrich: "Enrich",
  sync: "Sync", memories: "Memories",
};

export function CloudConsolePage() {
  const [tab, setTab] = useState<Tab>("overview");

  return (
    <div className="proto-cloud-console h-full flex flex-col">
      <div className="cc-tabs flex border-b border-zinc-800 px-3">
        {TABS.map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={
              "px-4 py-2 text-sm border-b-2 transition-colors " +
              (tab === t
                ? "border-emerald-400 text-emerald-300"
                : "border-transparent text-zinc-400 hover:text-zinc-200")
            }
          >
            {LABELS[t]}
          </button>
        ))}
      </div>
      <div className="flex-1 overflow-auto">
        {tab === "overview" && <OverviewTab />}
        {tab === "devices" && <DevicesTab />}
        {tab === "enrich" && <EnrichTab />}
        {tab === "sync" && <CloudSyncPage />}
        {tab === "memories" && (
          <div className="p-4">
            <DraftInbox hasConfig={true} />
          </div>
        )}
      </div>
    </div>
  );
}
