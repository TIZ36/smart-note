import { useEffect, useState } from "react";
import { Sparkles } from "lucide-react";
import * as cloudApi from "@/lib/cloud-api";

/* Inline agent-presence callout. Lives at the top of the canvas
 * when a note-shaped channel is active and there's recent agent
 * activity touching the workspace. Quietly tells the user "your
 * agents have been doing things"; nothing demands a response, but
 * the affordance to dive in is one click away.
 *
 * The callout is the *single* tinted-blue surface anywhere on the
 * page — accent color is earned by being the most important thing
 * on the canvas at that moment. Per .impeccable.md "earn every
 * accent."
 *
 * Visibility:
 *   - hidden when cloud isn't configured
 *   - hidden when there's no recent agent signal (no jobs in last
 *     24h AND no pending proposals)
 *   - hidden once dismissed (session-scoped — re-shows on next
 *     mount; the activity feed is the persistent surface)
 */

type Props = {
  onShowActivity: () => void;
};

type Snapshot = {
  reads: number;       // count of done jobs in last 24h
  proposals: number;   // pending memory drafts
  lastSeenAt: string | null;
};

const POLL_MS = 30_000;
const RECENT_WINDOW_MS = 24 * 60 * 60 * 1000;

export function InlinePresenceCard({ onShowActivity }: Props) {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    let alive = true;
    async function load() {
      try {
        if (!(await cloudApi.isCloudConfigured())) {
          if (alive) setSnap(null);
          return;
        }
        const [jobs, props] = await Promise.all([
          cloudApi.listEnrichJobs("done").catch(() => [] as cloudApi.EnrichJob[]),
          cloudApi.listProposals(8).catch(() => ({ proposals: [] as cloudApi.Proposal[], total: 0 })),
        ]);
        const cutoff = Date.now() - RECENT_WINDOW_MS;
        const recent = jobs.filter((j) =>
          j.finished_at && Date.parse(j.finished_at) >= cutoff,
        );
        if (alive) {
          setSnap({
            reads: recent.length,
            proposals: props.proposals.length,
            lastSeenAt: recent[0]?.finished_at || props.proposals[0]?.created_at || null,
          });
        }
      } catch { /* silent */ }
    }
    load();
    const id = setInterval(load, POLL_MS);
    return () => { alive = false; clearInterval(id); };
  }, []);

  if (dismissed) return null;
  if (!snap) return null;
  if (snap.reads === 0 && snap.proposals === 0) return null;

  return (
    <div className="proto-atelier-presence" role="status">
      <span className="proto-atelier-presence-icon">
        <Sparkles size={13} strokeWidth={2} />
      </span>
      <div className="proto-atelier-presence-body">
        {summary(snap)}
        {snap.lastSeenAt && (
          <span className="proto-atelier-presence-meta">
            last activity {relative(snap.lastSeenAt)}
          </span>
        )}
      </div>
      <div className="proto-atelier-presence-actions">
        <button
          type="button"
          className="proto-atelier-presence-action proto-atelier-presence-action-strong"
          onClick={onShowActivity}
        >
          See activity
        </button>
        <button
          type="button"
          className="proto-atelier-presence-action"
          onClick={() => setDismissed(true)}
          title="Hide for this session"
        >
          hide
        </button>
      </div>
    </div>
  );
}

function summary(s: Snapshot): React.ReactNode {
  const parts: React.ReactNode[] = [];
  if (s.reads > 0) {
    parts.push(
      <span key="reads">
        Your knowledge was read by agents <strong>{s.reads} time{s.reads === 1 ? "" : "s"}</strong> today.
      </span>
    );
  }
  if (s.proposals > 0) {
    parts.push(
      <span key="props">
        {parts.length > 0 ? " " : ""}
        Cursor and Claude Code proposed <strong>{s.proposals} memor{s.proposals === 1 ? "y" : "ies"}</strong> for review.
      </span>
    );
  }
  return <>{parts}</>;
}

function relative(iso: string): string {
  const sec = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.round(hr / 24)}d ago`;
}
