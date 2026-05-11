import { useEffect, useState } from "react";
import * as cloudApi from "@/lib/cloud-api";

/* Per-document pipeline state map.
 *
 * Backs the small status chips next to each tree row (Wiki + Notes
 * panes). Rolls up the latest run per (document_id, kind) from
 * listRecentRuns so we don't need to fetch /kn for every doc.
 *
 * Refresh triggers:
 *   - on mount
 *   - every 6s (background poll, cheap; the table is small at v3.6)
 *   - when any "smartnote:doc-pipeline-changed" custom event fires
 *     (App.tsx bridges WS events into these so the chips flip
 *     within a few hundred ms of cloud emitting *_done)
 *
 * Returns: Map<docId, {chunk_embed, ai_enrich, wiki_abstract}>
 *   each stage value: "queued" | "running" | "done" | "failed"
 *                   | "partial" | "skipped" | undefined (= no run)
 */

export type StageState =
  | "queued" | "running" | "done" | "failed" | "partial" | "skipped";

export type DocStates = {
  chunk_embed?: StageState;
  chunk_enrich?: StageState;
  graph_topology?: StageState;
  wiki_abstract?: StageState;
  note_classify?: StageState;
  // Legacy alias — old name preserved for existing call sites; new
  // code should read chunk_enrich.
  ai_enrich?: StageState;
  // Most recent terminal run for the whole doc — used to derive
  // an "overall" status for filter/dot UI.
  overall?: StageState;
};

export function useDocPipelineStates(): Map<string, DocStates> {
  const [states, setStates] = useState<Map<string, DocStates>>(new Map());

  useEffect(() => {
    let alive = true;
    let pollHandle: number | null = null;
    let inflight = false;

    async function refresh() {
      if (inflight) return;
      inflight = true;
      try {
        const runs = await cloudApi.listRecentRuns(200);
        if (!alive) return;
        const m = new Map<string, DocStates>();
        // listRecentRuns returns newest-first; take the FIRST seen
        // per (doc, kind) and skip the rest.
        for (const r of runs) {
          const key = `${r.document_id}::${r.kind}`;
          // We rely on iteration order: first hit wins.
          const cur = m.get(r.document_id) || {};
          const k = r.kind as keyof DocStates;
          if (cur[k] === undefined) {
            const s = normalizeStatus(r.status);
            cur[k] = s;
            // overall = the most recent terminal-or-running across kinds
            if (!cur.overall || _rank(s) > _rank(cur.overall)) cur.overall = s;
            m.set(r.document_id, cur);
          }
          void key;
        }
        setStates(m);
      } catch {
        /* silent — chip layer is decorative */
      } finally {
        inflight = false;
      }
    }

    refresh();
    pollHandle = window.setInterval(refresh, 6_000);

    function onWsBridge() { refresh(); }
    window.addEventListener("smartnote:doc-pipeline-changed", onWsBridge);
    window.addEventListener("smartnote:wiki-abstract-progress", onWsBridge);
    // P1-7: catch up after a WS reconnect — events that arrived
    // while we were offline aren't replayed by the cloud bridge,
    // so refetch the rolled-up state to bridge the gap.
    window.addEventListener("smartnote:ws-recovered", onWsBridge);

    return () => {
      alive = false;
      if (pollHandle) window.clearInterval(pollHandle);
      window.removeEventListener("smartnote:doc-pipeline-changed", onWsBridge);
      window.removeEventListener("smartnote:wiki-abstract-progress", onWsBridge);
      window.removeEventListener("smartnote:ws-recovered", onWsBridge);
    };
  }, []);

  return states;
}

function normalizeStatus(s: string): StageState {
  if (s === "skipped_dedup" || s === "skipped_quota") return "skipped";
  if (s === "queued" || s === "running" || s === "done"
      || s === "failed" || s === "partial" || s === "skipped") {
    return s;
  }
  return "done";
}

/* Higher rank wins when computing overall status: running > failed
 * > partial > done > queued > skipped. Logic: "running" should be
 * loudest in the tree dot; failures should beat dones; skipped is
 * the quietest. */
function _rank(s: StageState): number {
  return ({ running: 5, failed: 4, partial: 3, done: 2, queued: 1, skipped: 0 } as Record<StageState, number>)[s] ?? 0;
}
