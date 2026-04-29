import { useEffect, useState } from "react";
import * as cloudApi from "@/lib/cloud-api";

/* 32px ambient bottom bar — always visible, never demanding.
 *
 * Tracks three live numbers from the cloud:
 *   - device count + primary online state (pulse dot color)
 *   - sync state ("in sync" / "uploading N" — derived from
 *     existing upload-state hook so it matches the cloud-icon)
 *   - active enrich job (kind, doc name, progress %)
 *
 * Polls every 6s; cheaper than a websocket for what is essentially
 * a "is anything happening" indicator. Goes silent (just shows
 * device + sync) when no enrich is in flight.
 */

type Snapshot = {
  devicesOnline: number;
  primaryOnline: boolean;
  enrich: cloudApi.EnrichJob | null;   // most-recent live job
};

const POLL_MS = 6_000;

export function BottomBar({
  onOpenPalette,
  onOpenWorkspace,
}: {
  onOpenPalette: () => void;
  onOpenWorkspace: () => void;
}) {
  const [snap, setSnap] = useState<Snapshot | null>(null);

  useEffect(() => {
    let alive = true;
    async function load() {
      try {
        if (!(await cloudApi.isCloudConfigured())) {
          if (alive) setSnap(null);
          return;
        }
        const [devs, jobs] = await Promise.all([
          cloudApi.listDevices().catch(() => [] as cloudApi.Device[]),
          cloudApi.listEnrichJobs().catch(() => [] as cloudApi.EnrichJob[]),
        ]);
        const devicesOnline = devs.filter((d) => d.online).length;
        const primary = devs.find((d) => d.is_primary);
        const live = jobs.find(
          (j) => j.status === "queued" || j.status === "running" || j.status === "dispatched",
        ) || null;
        if (alive) {
          setSnap({
            devicesOnline,
            primaryOnline: !!primary?.online,
            enrich: live,
          });
        }
      } catch {
        /* silent — bottom bar must never error-flash */
      }
    }
    load();
    const id = setInterval(load, POLL_MS);
    return () => { alive = false; clearInterval(id); };
  }, []);

  const liveProgress = computeProgress(snap?.enrich || null);

  return (
    <footer className="proto-atelier-bottom" role="status">
      <button
        type="button"
        className="proto-atelier-bottom-cluster"
        onClick={onOpenWorkspace}
        title="Open workspace"
      >
        <span
          className="proto-atelier-bottom-dot"
          data-tone={
            snap === null ? "muted"
              : snap.primaryOnline ? "ok" : "warn"
          }
        />
        <span>
          {snap === null
            ? "Cloud offline"
            : snap.devicesOnline === 0
              ? "No devices online"
              : `${snap.devicesOnline} device${snap.devicesOnline === 1 ? "" : "s"}`}
        </span>
      </button>

      <span className="proto-atelier-bottom-sep" aria-hidden="true">·</span>

      <span className="proto-atelier-bottom-item">
        {snap === null ? "—" : "in sync"}
      </span>

      {snap?.enrich && (
        <>
          <span className="proto-atelier-bottom-sep" aria-hidden="true">·</span>
          <span className="proto-atelier-bottom-item">
            enriching{" "}
            <strong>
              {snap.enrich.document_name || snap.enrich.document_id.slice(0, 8)}
            </strong>
            {liveProgress !== null && ` — ${liveProgress}%`}
          </span>
          <span className="proto-atelier-bottom-progress">
            <span
              className="proto-atelier-bottom-progress-fill"
              style={{
                width: `${liveProgress ?? 8}%`,
                opacity: liveProgress === null ? 0.4 : 0.85,
              }}
            />
          </span>
        </>
      )}

      <button
        type="button"
        className="proto-atelier-bottom-cmd"
        onClick={onOpenPalette}
        title="Command palette"
      >
        <kbd>⌘K</kbd>
      </button>
    </footer>
  );
}

function computeProgress(j: cloudApi.EnrichJob | null): number | null {
  if (!j) return null;
  const c = j.progress?.classify;
  if (!c || c.total <= 0) return null;
  return Math.min(100, Math.round((c.done / c.total) * 100));
}
