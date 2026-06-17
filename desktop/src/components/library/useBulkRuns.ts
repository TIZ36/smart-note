import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as cloudApi from "@/lib/cloud-api";
import type { CloudDocument } from "@/lib/cloud-api";
import { onWsEvent } from "@/lib/electron";
import type { RunKind, RunStatus } from "./bulkTypes";

// Bulk pipeline runner extracted from the old RAGPage. Drives a
// concurrency-limited per-doc workload so the UI reflects each
// completion in real time instead of one giant blocking call.
//
// Returns everything LibraryDocsPane needs to render its bulk-action
// bar: per-kind running / progress counts, the runs map (passed to
// ProcessingPanel), action handlers, and a transient flash banner.

type Flash = { msg: string; tone: "ok" | "err" } | null;

export type BulkRuns = ReturnType<typeof useBulkRuns>;

function processingFinalStatus(result: unknown): { status: RunStatus["status"]; note?: string } {
  const run = result as cloudApi.ProcessingRunResult;
  if (run.status === "done" || run.status === "partial" || run.status === "skipped_dedup") {
    return { status: "done" };
  }
  if (run.status === "failed") {
    const error = typeof run.error === "string" ? run.error : run.error?.message;
    return { status: "failed", note: String(error || "processing failed") };
  }
  return { status: "running", note: run.status || "queued" };
}

export function useBulkRuns(opts: {
  docs: CloudDocument[] | null;
}) {
  const { docs } = opts;

  const [runs, setRuns] = useState<Map<string, RunStatus>>(new Map());
  const [flash, setFlash] = useState<Flash>(null);
  // Cloud LLM provider readiness — Enrich + Wiki-smartsheet need an
  // api_key on /v1/enrich/provider. Gating up-front avoids a 412
  // mid-run.
  const [cloudProviderReady, setCloudProviderReady] = useState<boolean | null>(null);

  /* Per integration doc §5.3: bulk runs auto-tail graph_topology
   * after upstream completes — explicitly client-driven, not a
   * cloud-side cascade. We track which docs the user opted in for
   * (i.e. dispatched via runStage with autoTail) and fire topology
   * for each as its upstream processing_done arrives. */
  const pendingTopologyTail = useRef<Set<string>>(new Set());

  useEffect(() => {
    let alive = true;
    cloudApi.fetchEnrichProvider()
      .then((cfg) => { if (alive) setCloudProviderReady(!!cfg.has_api_key); })
      .catch(() => { if (alive) setCloudProviderReady(false); });
    return () => { alive = false; };
  }, []);

  // Safety net: WS events can be lost (zombie socket, NAT drop,
  // missed reconnect). Without a fallback, a row that started
  // running and then never sees `processing_done` stays "running"
  // until the user restarts the app. Every 5s, look at in-flight
  // rows that carry a runId and ask the cloud for the authoritative
  // status; flip the row when the cloud says it's terminal.
  const runsRef = useRef(runs);
  runsRef.current = runs;
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      const inflight: Array<{ docId: string; runId: string }> = [];
      for (const [docId, r] of runsRef.current) {
        if ((r.status === "running" || r.status === "queued") && r.runId) {
          inflight.push({ docId, runId: r.runId });
        }
      }
      if (inflight.length === 0) return;
      await Promise.all(inflight.map(async ({ docId, runId }) => {
        try {
          const remote = await cloudApi.getRun(runId);
          if (!alive) return;
          const s = remote.status;
          if (s === "done" || s === "partial" || s === "skipped_dedup") {
            patchRun(docId, { status: "done", finishedAt: Date.now(), message: "Complete" });
          } else if (s === "failed" || s === "skipped_quota") {
            const err = typeof remote.error === "string"
              ? remote.error
              : (remote.error as { message?: string } | null)?.message;
            patchRun(docId, { status: "failed", finishedAt: Date.now(), error: err || "failed", message: err || "Failed" });
          }
        } catch {
          /* silent — transient lookup failure; we'll retry next tick */
        }
      }));
    };
    const id = window.setInterval(tick, 5_000);
    return () => { alive = false; window.clearInterval(id); };
  }, []);

  // Cloud processing events drive run rows after the initial click.
  // All stages now share processing_progress / processing_done.
  useEffect(() => {
    const off = onWsEvent((e) => {
      const docId = (e as { document_id?: string }).document_id;
      if (!docId) return;
      const stage = (e as { stage?: string }).stage;
      const type = String(e.type || "");
      if (type !== "processing_progress" && type !== "processing_done") return;
      const statusRaw = (e as { status?: string }).status;
      const progress = (e as { progress?: { current?: number; total?: number } }).progress;
      const message = (e as { message?: string }).message;
      const error = (e as { error?: string | { message?: string } }).error;
      const kind: RunKind = stage === "chunk_embed"
        ? "embed"
        : stage === "chunk_enrich"
          ? "enrich"
          : stage === "graph_topology"
            ? "graph"
            : "tag";
      setRuns((prev) => {
        const cur = prev.get(docId);
        const next = new Map(prev);
        next.set(docId, {
          kind: cur?.kind || kind,
          status: statusRaw === "done" || statusRaw === "partial" || statusRaw === "skipped_dedup"
            ? "done"
            : statusRaw === "failed"
              ? "failed"
              : "running",
          startedAt: cur?.startedAt ?? Date.now(),
          finishedAt: type === "processing_done" ? Date.now() : cur?.finishedAt,
          name: cur?.name || docs?.find((x) => x.id === docId)?.name || docId.slice(0, 8),
          runId: (e as { run_id?: string }).run_id || cur?.runId,
          message: message || cur?.message,
          progressCurrent: progress?.current ?? cur?.progressCurrent,
          progressTotal: progress?.total ?? cur?.progressTotal,
          error: typeof error === "string" ? error : error?.message || (statusRaw === "failed" ? message : undefined) || cur?.error,
        });
        return next;
      });

      // ── Auto-tail graph_topology ──
      // When an upstream stage finishes for a doc the user dispatched
      // via runStage, fire graph_topology for that doc. Topology is
      // per-doc + cheap (no LLM); running it as the upstream lands
      // keeps document_links fresh without a cloud-side cascade.
      // Bypasses the tracker (sends POST directly) so it doesn't
      // race with this listener; topology's own WS events will add
      // a "graph" row to the runs map normally.
      if (
        type === "processing_done"
        && (statusRaw === "done" || statusRaw === "partial" || statusRaw === "skipped_dedup")
        && stage !== "graph_topology"
        && pendingTopologyTail.current.has(docId)
      ) {
        pendingTopologyTail.current.delete(docId);
        cloudApi.runStage(docId, "graph_topology").catch(() => {
          /* silent — user can manually update topology if it failed */
        });
      }
    });
    return off;
  }, [docs]);

  function flashSet(msg: string, tone: "ok" | "err" = "ok") {
    setFlash({ msg, tone });
    setTimeout(() => setFlash(null), 2400);
  }

  function patchRun(id: string, patch: Partial<RunStatus>) {
    setRuns((prev) => {
      const next = new Map(prev);
      const cur = next.get(id);
      if (cur) next.set(id, { ...cur, ...patch });
      return next;
    });
  }

  // resolveFinalStatus lets the per-stage runner inspect the cloud
  // response and report whether the work ACTUALLY finished. Without
  // it, runBulk would treat HTTP 200 as "done" — which is wrong for
  // processing, where the cloud's POST returns after queuing the run.
  // We need to tell the user "queued" not "done" in that case, and
  // only mark "done" when processing_done arrives.
  type FinalStatus = { status: RunStatus["status"]; note?: string };
  const runBulk = useCallback(async (
    kind: RunKind,
    ids: string[],
    label: string,
    perDoc: (id: string) => Promise<unknown>,
    conc = 4,
    resolveFinalStatus?: (result: unknown) => FinalStatus,
  ) => {
    if (ids.length === 0) return;
    const now = Date.now();
    setRuns((prev) => {
      const next = new Map(prev);
      for (const id of ids) {
        const d = docs?.find((x) => x.id === id);
        next.set(id, {
          kind,
          status: "queued",
          startedAt: now,
          name: d?.name || id.slice(0, 8),
          message: "Queued for cloud processing",
        });
      }
      return next;
    });
    let cursor = 0;
    let succ = 0;
    let fail = 0;
    let pending = 0;
    const worker = async () => {
      while (cursor < ids.length) {
        const i = cursor++;
        const id = ids[i];
        patchRun(id, { status: "running", startedAt: Date.now(), message: "Contacting cloud" });
        try {
          const result = await perDoc(id);
          const final: FinalStatus = resolveFinalStatus
            ? resolveFinalStatus(result)
            : { status: "done" };
          // Capture the cloud-assigned run_id from the POST response so
          // the 5s safety-net poll can query authoritative status even
          // when no WS event ever arrives. Without this, runId stays
          // undefined until the first WS event, defeating the fallback.
          const runId = (result as { run_id?: string } | null | undefined)?.run_id;
          if (final.status === "done") {
            succ++;
            patchRun(id, { status: "done", finishedAt: Date.now(), message: final.note || "Complete", ...(runId ? { runId } : {}) });
          } else if (final.status === "failed") {
            fail++;
            patchRun(id, {
              status: "failed",
              finishedAt: Date.now(),
              message: final.note || "Failed",
              error: final.note || "failed",
              ...(runId ? { runId } : {}),
            });
          } else {
            // queued / running — leave the row tracked. The WS
            // listener flips it to done when processing_done lands.
            pending++;
            patchRun(id, {
              status: "running",
              message: final.note,
              ...(final.note ? { error: final.note } : {}),
              ...(runId ? { runId } : {}),
            });
          }
        } catch (e) {
          fail++;
          const err = e instanceof Error ? e.message : String(e);
          patchRun(id, { status: "failed", finishedAt: Date.now(), message: err, error: err });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(conc, ids.length) }, () => worker()));
    // Flash semantics under the new processing model.
    //
    // Cloud's POST /v1/processing/{id}/run is always non-blocking:
    // it inserts a processing_runs row, kicks a background task,
    // and returns immediately with status="running". So `pending`
    // here is the EXPECTED outcome on dispatch, not an error
    // condition. The row flips to "done" when the WS listener
    // receives processing_done.
    //
    // We only treat things as failures when the cloud reported a
    // synchronous failure (HTTP 4xx/5xx OR returned status="failed"
    // with a real error.code). The misleading "configure Cloud AI
    // provider" hint is now scoped to LLM-bearing stages where the
    // cloud actually returned an executor-availability error.
    let msg: string;
    let tone: "ok" | "err" = "ok";
    if (fail > 0 && succ + pending === 0) {
      msg = `${label}: ${fail} failed`;
      tone = "err";
    } else if (fail > 0) {
      msg = `${label}: ${succ + pending} dispatched · ${fail} failed`;
      tone = "err";
    } else if (pending > 0 && succ === 0) {
      // Pure dispatched run — typical for LLM stages (cloud returns
      // running, background task does the work). Informational.
      msg = `${label}: ${pending} dispatched · waiting for cloud`;
    } else if (pending > 0) {
      msg = `${label}: ${succ} done · ${pending} dispatched`;
    } else {
      msg = `${label}: ${succ} source${succ === 1 ? "" : "s"}`;
    }
    flashSet(msg, tone);
  }, [docs]);

  /* Generic per-stage runner. Drives the cloud
   *   POST /v1/processing/{id}/run
   * for any of the five canonical kinds. Per-kind helpers below are
   * thin wrappers that pre-set common options + label + concurrency
   * so call sites read naturally. The integration doc (§4) is the
   * source of truth for which kind a UI button maps to.
   */
  const KIND_PROFILE: Record<cloudApi.ProcessingKind, {
    runKind: RunKind;
    label: string;
    conc: number;
    needsCloudProvider: boolean;
    forceDefault: boolean;
  }> = {
    chunk_embed:    { runKind: "embed",  label: "Embed",          conc: 4, needsCloudProvider: false, forceDefault: false },
    chunk_enrich:   { runKind: "enrich", label: "Enrich",         conc: 3, needsCloudProvider: true,  forceDefault: false },
    wiki_abstract:  { runKind: "tag",    label: "Build abstract", conc: 2, needsCloudProvider: true,  forceDefault: true },
    note_classify:  { runKind: "tag",    label: "Tag-classify",   conc: 2, needsCloudProvider: true,  forceDefault: false },
    graph_topology: { runKind: "graph",  label: "Topology",       conc: 4, needsCloudProvider: false, forceDefault: false },
  };

  const runStage = useCallback(async (
    kind: cloudApi.ProcessingKind,
    ids: string[],
    opts: { force?: boolean; cloudOptions?: Record<string, unknown>; autoTail?: boolean } = {},
  ) => {
    if (ids.length === 0) return;
    const prof = KIND_PROFILE[kind];
    if (prof.needsCloudProvider && !cloudProviderReady) {
      flashSet(
        `${prof.label} needs a Cloud AI provider — open Cloud panel → Cloud AI provider.`,
        "err",
      );
      return;
    }
    const force = opts.force ?? prof.forceDefault;
    // Register topology auto-tail for non-topology stages by default.
    // Caller can opt out (e.g. internal topology trigger) via autoTail:false.
    const wantsTail = kind !== "graph_topology" && (opts.autoTail ?? true);
    if (wantsTail) {
      ids.forEach((id) => pendingTopologyTail.current.add(id));
    }
    await runBulk(
      prof.runKind, ids, prof.label,
      (id) => cloudApi.runStage(id, kind, force, opts.cloudOptions ?? {}),
      prof.conc,
      processingFinalStatus,
    );
  }, [cloudProviderReady, runBulk]);

  // Per-kind aliases — keep call-site naming readable. All delegate
  // to runStage so behavior, gating, and progress tracking stay in
  // one place.
  const runEmbed         = useCallback((ids: string[]) =>
    runStage("chunk_embed", ids), [runStage]);
  const runEnrich        = useCallback((ids: string[]) =>
    runStage("chunk_enrich", ids), [runStage]);
  const runWikiSmartsheet = useCallback((ids: string[]) => {
    if (ids.length === 0) {
      flashSet("Select at least one Wiki topic to build a smartsheet.", "err");
      return Promise.resolve();
    }
    return runStage("wiki_abstract", ids);
  }, [runStage]);
  const runNoteClassify  = useCallback((ids: string[]) =>
    runStage("note_classify", ids), [runStage]);
  const runGraphTopology = useCallback((ids: string[]) =>
    runStage("graph_topology", ids), [runStage]);

  /** Cancel an in-flight processing run by its run_id. */
  const cancelRun = useCallback(async (runId: string) => {
    try {
      await cloudApi.cancelProcessingRun(runId);
      flashSet(`Run ${runId.slice(0, 8)} cancelled`);
      // Patch any tracked rows whose runId matches; collapse to "done"
      // so the spinner stops. The next /kn refetch will reconcile.
      setRuns((prev) => {
        const next = new Map(prev);
        for (const [docId, r] of prev) {
          if (r.runId === runId && (r.status === "running" || r.status === "queued")) {
            next.set(docId, { ...r, status: "failed", finishedAt: Date.now(), error: "cancelled" });
          }
        }
        return next;
      });
    } catch (e) {
      flashSet(`Cancel failed: ${e instanceof Error ? e.message : String(e)}`, "err");
    }
  }, []);

  /** Workspace-level entity graph refresh. Distinct from per-doc
   *  graph_topology — this is a read-only fetch used by the Graph
   *  tab's workspace overview section. Kept here for the legacy
   *  workspace-rebuild button. */
  const runGraph = useCallback(async () => {
    const id = "__graph__";
    setRuns((prev) => {
      const next = new Map(prev);
      next.set(id, { kind: "graph", status: "running", startedAt: Date.now(), name: "Entity graph" });
      return next;
    });
    try {
      await cloudApi.fetchGraph();
      patchRun(id, { status: "done", finishedAt: Date.now() });
      flashSet("Entity graph refreshed");
    } catch (e) {
      patchRun(id, { status: "failed", finishedAt: Date.now(), error: e instanceof Error ? e.message : String(e) });
      flashSet(e instanceof Error ? e.message : String(e), "err");
    }
  }, []);

  const clearDone = useCallback(() => {
    setRuns((prev) => {
      const next = new Map(prev);
      for (const [id, r] of prev) if (r.status === "done" || r.status === "failed") next.delete(id);
      return next;
    });
  }, []);

  // Per-kind running / progress counts for the action tiles.
  const runStats = useMemo(() => {
    const empty = { running: 0, done: 0, failed: 0, total: 0 };
    const by: Record<RunKind, typeof empty> = {
      embed:  { ...empty }, enrich: { ...empty }, tag: { ...empty }, graph: { ...empty },
    };
    for (const r of runs.values()) {
      const b = by[r.kind];
      b.total++;
      if (r.status === "running" || r.status === "queued") b.running++;
      else if (r.status === "done") b.done++;
      else if (r.status === "failed") b.failed++;
    }
    return by;
  }, [runs]);

  const busyKinds = useMemo(() => {
    const s = new Set<RunKind>();
    for (const k of Object.keys(runStats) as RunKind[]) {
      if (runStats[k].running > 0) s.add(k);
    }
    return s;
  }, [runStats]);

  return {
    runs,
    flash,
    flashSet,
    cloudProviderReady,
    runStats,
    busyKinds,
    // Generic per-stage runner — preferred for new call sites.
    runStage,
    // Per-kind aliases.
    runEmbed,
    runEnrich,
    runWikiSmartsheet,
    runNoteClassify,
    runGraphTopology,
    // Workspace-scope entity graph refresh (legacy "Rebuild graph").
    runGraph,
    cancelRun,
    clearDone,
  };
}
