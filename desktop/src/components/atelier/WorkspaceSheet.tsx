import { useEffect, useState } from "react";
import { Star, Plus } from "lucide-react";
import * as cloudApi from "@/lib/cloud-api";
import { cn } from "@/lib/cn";
import type { ChannelId } from "@/lib/types";

/* Workspace bottom sheet — slides up from the bottom when the user
 * clicks the Layers icon on the rail or the device cluster on the
 * bottom bar. Replaces the dedicated Cloud Console / Settings tabs
 * for the most common at-a-glance use cases:
 *
 *   - Devices (paired devices, last-seen, primary indicator)
 *   - Plan & usage (memory / doc / token counts)
 *   - LLM provider (model, concurrency, auto-enrich toggle)
 *
 * Power flows that need real CRUD (issue API key, edit provider key)
 * still link out to the existing Cloud Console — the sheet has a
 * "manage all" link at the bottom of each section that switches the
 * channel to `cloud-sync`.
 */

type Props = {
  open: boolean;
  onClose: () => void;
  onSelect: (channel: ChannelId) => void;
};

type Snapshot = {
  devices: cloudApi.Device[];
  usage: cloudApi.Usage | null;
  provider: cloudApi.EnrichProviderConfig | null;
};

export function WorkspaceSheet({ open, onClose, onSelect }: Props) {
  const [snap, setSnap] = useState<Snapshot | null>(null);

  // Lazy load: only fetch when the sheet first opens. Re-opens reuse
  // the most recent snapshot for instant render; we re-fetch in the
  // background to keep numbers fresh.
  useEffect(() => {
    if (!open) return;
    let alive = true;
    (async () => {
      try {
        if (!(await cloudApi.isCloudConfigured())) return;
        const [devices, usage, provider] = await Promise.all([
          cloudApi.listDevices().catch(() => [] as cloudApi.Device[]),
          cloudApi.fetchUsage().catch(() => null),
          cloudApi.fetchEnrichProvider().catch(() => null),
        ]);
        if (alive) setSnap({ devices, usage, provider });
      } catch { /* silent */ }
    })();
    return () => { alive = false; };
  }, [open]);

  return (
    <>
      <div
        className={cn("proto-atelier-veil", open && "proto-atelier-veil-open")}
        onClick={onClose}
        aria-hidden="true"
      />
      <section
        className={cn("proto-atelier-sheet", open && "proto-atelier-sheet-open")}
        role="dialog"
        aria-label="Workspace"
        aria-hidden={!open}
      >
        <div className="proto-atelier-sheet-grab" aria-hidden="true" />
        <header className="proto-atelier-sheet-head">
          <div className="proto-atelier-sheet-title">Workspace</div>
          <div className="proto-atelier-sheet-meta">
            {snap === null
              ? "Cloud not configured."
              : describeSheet(snap)}
          </div>
        </header>

        <div className="proto-atelier-sheet-body">
          <SheetCard
            title="Devices"
            footerHref={() => onSelect("cloud-sync")}
            footerLabel="Manage devices →"
          >
            {snap === null
              ? <Empty>Open the Cloud tab to configure cloud sync.</Empty>
              : snap.devices.length === 0
                ? <Empty>No devices paired yet.</Empty>
                : snap.devices.map((d) => (
                    <Row key={d.id}>
                      <span
                        className="proto-atelier-bottom-dot"
                        data-tone={d.online ? "ok" : "muted"}
                        style={{ width: 6, height: 6 }}
                      />
                      <span>{d.name}</span>
                      {d.is_primary && (
                        <span className="proto-atelier-sheet-badge"><Star size={10} /> primary</span>
                      )}
                      <span className="proto-atelier-sheet-meta-r">
                        {d.last_seen_at ? relative(d.last_seen_at) : "never"}
                      </span>
                    </Row>
                  ))}
            <RowAction onClick={() => onSelect("cloud-sync")}>
              <Plus size={11} /> Pair new device
            </RowAction>
          </SheetCard>

          <SheetCard
            title="Plan & usage"
            footerHref={() => onSelect("cloud-sync")}
            footerLabel="Manage plan →"
          >
            {snap?.usage ? (
              <>
                <Row><span>Memories</span><span className="proto-atelier-sheet-meta-r">{snap.usage.memory_count}</span></Row>
                <Row><span>Documents</span><span className="proto-atelier-sheet-meta-r">{snap.usage.document_count}</span></Row>
                <Row><span>Embed tokens</span><span className="proto-atelier-sheet-meta-r">{snap.usage.embed_tokens.toLocaleString()}</span></Row>
                <Row><span>Retrieve calls</span><span className="proto-atelier-sheet-meta-r">{snap.usage.retrieve_calls.toLocaleString()}</span></Row>
              </>
            ) : (
              <Empty>Plan info unavailable.</Empty>
            )}
          </SheetCard>

          <SheetCard
            title="LLM provider"
            footerHref={() => onSelect("cloud-sync")}
            footerLabel="Edit credentials →"
          >
            {snap?.provider?.has_api_key ? (
              <>
                <Row><span>Model</span><span className="proto-atelier-sheet-meta-r">{snap.provider.model}</span></Row>
                <Row><span>Base URL</span><span className="proto-atelier-sheet-meta-r" style={{ maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{snap.provider.base_url}</span></Row>
                <Row><span>Concurrency</span><span className="proto-atelier-sheet-meta-r">{snap.provider.max_concurrency}</span></Row>
                <Row>
                  <span>Auto-enrich</span>
                  <span
                    className="proto-atelier-sheet-meta-r"
                    style={{ color: snap.provider.auto_enrich_on_ingest ? "var(--color-success)" : "var(--color-text-muted)" }}
                  >
                    {snap.provider.auto_enrich_on_ingest ? "on" : "off"}
                  </span>
                </Row>
              </>
            ) : (
              <Empty>No LLM key set. Add one to enable auto-enrich.</Empty>
            )}
          </SheetCard>
        </div>
      </section>
    </>
  );
}

function describeSheet(s: Snapshot): string {
  const parts: string[] = [];
  parts.push(`${s.devices.length} device${s.devices.length === 1 ? "" : "s"}`);
  if (s.usage) parts.push(`${s.usage.memory_count} memories`);
  if (s.provider?.has_api_key) parts.push(`provider: ${s.provider.model}`);
  return parts.join(" · ");
}

function SheetCard({
  title, footerHref, footerLabel, children,
}: {
  title: string;
  footerHref?: () => void;
  footerLabel?: string;
  children: React.ReactNode;
}) {
  return (
    <article className="proto-atelier-sheet-card">
      <div className="proto-atelier-sheet-card-title">{title}</div>
      <div className="proto-atelier-sheet-card-body">{children}</div>
      {footerHref && footerLabel && (
        <button
          type="button"
          className="proto-atelier-sheet-card-footer"
          onClick={footerHref}
        >
          {footerLabel}
        </button>
      )}
    </article>
  );
}

function Row({ children }: { children: React.ReactNode }) {
  return <div className="proto-atelier-sheet-row">{children}</div>;
}

function RowAction({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      className="proto-atelier-sheet-row proto-atelier-sheet-row-action"
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="proto-atelier-sheet-empty">{children}</div>;
}

function relative(iso: string): string {
  const sec = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h`;
  return `${Math.round(hr / 24)}d`;
}
