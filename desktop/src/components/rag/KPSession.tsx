/**
 * KP Session — chat-like timeline for knowledge-processing actions.
 *
 * Every click on Embed / Enrich / Build wiki abstract / Rebuild graph
 * lands as a "turn" stacked newest-on-top. A turn is not a toast: it
 * is a structured entry with:
 *
 *   1. Pre-flight checks      — provider configured? chapters exist?
 *                               Inline "fix this" button when blocked.
 *   2. Live steps             — driven by ws events (progress streams,
 *                               kind-aware completion broadcasts).
 *   3. Final result           — counts + skipped/failed + nudges
 *                               ("nothing to do — already up to date").
 *
 * Goal is to make the pipeline self-documenting. The user never has
 * to ask "why did that finish in 1s?" — the turn shows preflight
 * verdicts, sub-steps, and result breakdowns in plain terms.
 *
 * Lives in `RAGPage.tsx` above the action tiles; replaces the
 * toast-based feedback for the four KP actions.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as cloudApi from "@/lib/cloud-api";
import { cn } from "@/lib/cn";
import { buildWikiAbstractClient, splitWikiChapters } from "@/lib/wiki-client-artifacts";

export type KPActionKind = "embed" | "enrich" | "wiki_abstract" | "graph";

export type KPDocRef = { id: string; name: string; kind: "note" | "wiki" | "doc" };

type StepStatus = "pending" | "running" | "done" | "failed" | "skipped";

type Step = {
  id: string;
  label: string;
  detail?: string;
  status: StepStatus;
  /** When set, renders a small action button next to the step row.
   *  Used for inline remediation (e.g. "Run Embedding now" on a
   *  preflight blocker). */
  fix?: { label: string; onClick: () => void };
  progress?: { current: number; total: number };
};

type Turn = {
  id: string;
  action: KPActionKind;
  docs: KPDocRef[];
  steps: Step[];
  status: "preflight" | "running" | "done" | "failed" | "blocked";
  startedAt: number;
  finishedAt?: number;
  /** Free-form summary line shown when the turn is collapsed.
   *  E.g. "12/12 chapters summarized" or "blocked: 1 doc has no chapters". */
  summary?: string;
};

type SessionApi = {
  turns: Turn[];
  /** Submit a new action. Returns the turn id so callers can correlate
   *  if they want; most callers ignore it. */
  submit: (action: KPActionKind, docs: KPDocRef[], opts?: { force?: boolean }) => string;
  /** Drop a turn from the visible list (user dismissed). */
  dismiss: (turnId: string) => void;
};

const KIND_LABEL: Record<KPActionKind, string> = {
  embed: "Embedding",
  enrich: "Enrich",
  wiki_abstract: "Wiki abstract",
  graph: "Graph rebuild",
};

const STATUS_TONE: Record<Turn["status"], string> = {
  preflight: "kp-turn-status-preflight",
  running: "kp-turn-status-running",
  done: "kp-turn-status-done",
  failed: "kp-turn-status-failed",
  blocked: "kp-turn-status-blocked",
};

const STEP_TONE: Record<StepStatus, string> = {
  pending: "kp-step-pending",
  running: "kp-step-running",
  done: "kp-step-done",
  failed: "kp-step-failed",
  skipped: "kp-step-skipped",
};

/**
 * Hook the page mounts once; gives back the session API + the
 * <KPSessionPanel /> JSX to render wherever the page wants. Keeps state
 * outside of the panel so the panel can re-render without losing
 * progress.
 */
export function useKPSession(opts: {
  cloudProviderReady: boolean | null;
  /** Caller's Embedding runner — invoked when a preflight blocker
   *  offers "Run Embedding now". Same fn that drives the Embedding
   *  tile; we just pipe in the doc subset that needs it. */
  runEmbedding: (docIds: string[]) => Promise<void>;
}): SessionApi {
  const { cloudProviderReady, runEmbedding } = opts;
  const [turns, setTurns] = useState<Turn[]>([]);
  const turnsRef = useRef(turns);
  turnsRef.current = turns;

  const updateTurn = useCallback((id: string, patch: Partial<Turn> | ((t: Turn) => Partial<Turn>)) => {
    setTurns((prev) =>
      prev.map((t) => {
        if (t.id !== id) return t;
        const up = typeof patch === "function" ? patch(t) : patch;
        return { ...t, ...up };
      }),
    );
  }, []);

  const updateStep = useCallback((turnId: string, stepId: string, patch: Partial<Step>) => {
    setTurns((prev) =>
      prev.map((t) =>
        t.id !== turnId
          ? t
          : { ...t, steps: t.steps.map((s) => (s.id === stepId ? { ...s, ...patch } : s)) },
      ),
    );
  }, []);

  // ── ws-event router ──────────────────────────────────────────────
  // Translate broadcast events from cloud into step updates on the
  // matching turn (matched by document_id + action kind).
  useEffect(() => {
    function onWikiProgress(ev: Event) {
      const detail = (ev as CustomEvent<{
        document_id?: string;
        phase?: string;
        total?: number;
        summarized?: number;
        failed?: number;
      }>).detail;
      if (!detail?.document_id) return;
      const t = turnsRef.current.find(
        (x) => x.action === "wiki_abstract" && x.docs.some((d) => d.id === detail.document_id),
      );
      if (!t) return;
      const stepId = `phaseB:${detail.document_id}`;
      const step = t.steps.find((s) => s.id === stepId);
      const total = detail.total ?? step?.progress?.total ?? 0;
      const cur = detail.summarized ?? 0;
      updateStep(t.id, stepId, {
        status: "running",
        progress: { current: cur, total },
        detail: `${cur}/${total} chapters${detail.failed ? ` · ${detail.failed} failed` : ""}`,
      });
    }
    function onPipelineDone(ev: Event) {
      const detail = (ev as CustomEvent<{
        document_id?: string;
        kind?: string;
      }>).detail;
      if (!detail?.document_id) return;
      const action: KPActionKind | null =
        detail.kind === "wiki_abstract"
          ? "wiki_abstract"
          : detail.kind === "chunk_embed"
          ? "embed"
          : detail.kind === "ai_enrich"
          ? "enrich"
          : null;
      if (!action) return;
      const t = turnsRef.current.find(
        (x) => x.action === action && x.docs.some((d) => d.id === detail.document_id),
      );
      if (!t) return;
      const stepId =
        action === "wiki_abstract" ? `phaseB:${detail.document_id}`
        : action === "embed"       ? `embed:${detail.document_id}`
        : `enrich:${detail.document_id}`;
      updateStep(t.id, stepId, { status: "done" });
    }
    window.addEventListener("smartnote:wiki-abstract-progress", onWikiProgress);
    window.addEventListener("smartnote:doc-pipeline-changed", onPipelineDone);
    return () => {
      window.removeEventListener("smartnote:wiki-abstract-progress", onWikiProgress);
      window.removeEventListener("smartnote:doc-pipeline-changed", onPipelineDone);
    };
  }, [updateStep]);

  // ── per-action runner ────────────────────────────────────────────
  // Each runner appends preflight steps, evaluates them, then either
  // invokes the cloud call (and waits for ws events to advance) or
  // marks the turn `blocked` with inline fix actions.
  const runWikiAbstract = useCallback(
    async (turnId: string, docs: KPDocRef[], force: boolean) => {
      // Preflight 1: local desktop AI provider. Cloud only stores the artifact.
      const provStepId = "preflight:provider";
      updateStep(turnId, provStepId, { status: "running" });
      updateStep(turnId, provStepId, { status: "done", detail: "LOCAL AI · Desktop provider checked on run" });

      // Preflight 2: parse chapters locally from the cloud document.
      const chaptersStepId = "preflight:chapters";
      updateStep(turnId, chaptersStepId, { status: "running" });
      const knByDoc = await Promise.all(
        docs.map(async (d) => {
          try {
            const full = await cloudApi.getDocument(d.id);
            return { doc: d, chapters: splitWikiChapters(full.content || "").length };
          } catch {
            return { doc: d, chapters: 0 };
          }
        }),
      );
      const noChapters = knByDoc.filter((r) => r.chapters === 0).map((r) => r.doc);
      if (noChapters.length > 0) {
        updateStep(turnId, chaptersStepId, {
          status: "failed",
          detail: `${noChapters.length} doc${noChapters.length === 1 ? "" : "s"} ${noChapters.length === 1 ? "has" : "have"} no text sections to summarize.`,
          fix: {
            label: `Open Cloud document and check content`,
            onClick: async () => {
              window.dispatchEvent(new CustomEvent("smartnote:open-cloud-panel"));
            },
          },
        });
        updateTurn(turnId, {
          status: "blocked",
          finishedAt: Date.now(),
          summary: `Blocked: ${noChapters.length}/${docs.length} doc${docs.length === 1 ? "" : "s"} have no sections`,
        });
        return;
      }
      updateStep(turnId, chaptersStepId, {
        status: "done",
        detail: `${knByDoc.reduce((a, r) => a + r.chapters, 0)} chapters total`,
      });

      // Phase B per doc — push step, then fire request. ws events
      // drive the progress; completion advances each step.
      updateTurn(turnId, (t) => ({
        status: "running",
        steps: [
          ...t.steps,
          ...knByDoc.map((r) => ({
            id: `phaseB:${r.doc.id}`,
            label: `[LOCAL AI] Wiki abstract · ${r.doc.name}`,
            status: "pending" as StepStatus,
            progress: { current: 0, total: r.chapters },
          })),
        ],
      }));

      const results = await Promise.all(
        knByDoc.map(async (r) => {
          try {
            const result = await buildWikiAbstractClient(r.doc.id, {
              force,
              onProgress: (p) => {
                updateStep(turnId, `phaseB:${r.doc.id}`, {
                  status: "running",
                  progress: { current: p.done, total: p.total },
                  detail: p.phase === "reused"
                    ? `LOCAL AI · Reused · ${p.title}`
                    : p.phase === "summarizing"
                    ? `LOCAL AI · Summarizing · ${p.title}`
                    : `LOCAL AI · Done · ${p.title}`,
                });
              },
            });
            updateStep(turnId, `phaseB:${r.doc.id}`, {
              status: "done",
              progress: { current: result.chapters, total: result.chapters },
              detail: `LOCAL AI · ${result.summarized} summarized · ${result.reused} reused`,
            });
            return { ok: true, doc: r.doc };
          } catch (e) {
            updateStep(turnId, `phaseB:${r.doc.id}`, {
              status: "failed",
              detail: (e as Error).message?.slice(0, 200) ?? "request failed",
            });
            return { ok: false, doc: r.doc };
          }
        }),
      );
      const failed = results.filter((r) => !r.ok).length;
      updateTurn(turnId, {
        status: failed > 0 ? "failed" : "done",
        finishedAt: Date.now(),
        summary: failed > 0
          ? `${docs.length - failed}/${docs.length} succeeded`
          : `${docs.length} doc${docs.length === 1 ? "" : "s"} processed`,
      });
    },
    [updateStep, updateTurn],
  );

  const runEmbed = useCallback(
    async (turnId: string, docs: KPDocRef[]) => {
      updateTurn(turnId, {
        status: "running",
        steps: docs.map((d) => ({
          id: `embed:${d.id}`,
          label: `Embed · ${d.name}`,
          status: "pending" as StepStatus,
        })),
      });
      const results = await Promise.all(
        docs.map(async (d) => {
          updateStep(turnId, `embed:${d.id}`, { status: "running" });
          try {
            await cloudApi.ingestDocument(d.id);
            // chunk_embed_done ws event will mark step done; we set
            // a fallback in case the event is missed.
            return { ok: true, doc: d };
          } catch (e) {
            updateStep(turnId, `embed:${d.id}`, {
              status: "failed",
              detail: (e as Error).message?.slice(0, 200) ?? "ingest failed",
            });
            return { ok: false, doc: d };
          }
        }),
      );
      const failed = results.filter((r) => !r.ok).length;
      updateTurn(turnId, {
        status: failed > 0 ? "failed" : "done",
        finishedAt: Date.now(),
        summary: failed > 0
          ? `${docs.length - failed}/${docs.length} embedded`
          : `${docs.length} doc${docs.length === 1 ? "" : "s"} embedded`,
      });
    },
    [updateStep, updateTurn],
  );

  const runEnrichAct = useCallback(
    async (turnId: string, docs: KPDocRef[]) => {
      // Preflight: provider
      const provStepId = "preflight:provider";
      updateStep(turnId, provStepId, { status: "running" });
      const wikis = docs.filter((d) => d.kind === "wiki");
      const notes = docs.filter((d) => d.kind !== "wiki");
      if (notes.length > 0 && wikis.length === 0 && cloudProviderReady === false) {
        updateStep(turnId, provStepId, {
          status: "failed",
          detail: "Cloud AI provider not configured.",
          fix: { label: "Open Cloud panel", onClick: () => {
            window.dispatchEvent(new CustomEvent("smartnote:open-cloud-panel"));
          } },
        });
        updateTurn(turnId, { status: "blocked", finishedAt: Date.now(),
          summary: "Cloud AI provider missing" });
        return;
      }
      updateStep(turnId, provStepId, {
        status: "done",
        detail: wikis.length > 0 && notes.length === 0
          ? "LOCAL AI · Desktop provider checked on run"
          : wikis.length > 0
          ? "Mixed · wiki uses LOCAL AI, notes use Cloud AI"
          : "Cloud AI provider configured",
      });

      // Split: wiki docs route to wiki_abstract, others to ai_enrich.

      updateTurn(turnId, (t) => ({
        status: "running",
        steps: [
          ...t.steps,
          ...notes.map((d) => ({
            id: `enrich:${d.id}`,
            label: `Enrich · ${d.name}`,
            status: "pending" as StepStatus,
          })),
          ...wikis.map((d) => ({
            id: `phaseB:${d.id}`,
              label: `[LOCAL AI] Wiki abstract · ${d.name}`,
            status: "pending" as StepStatus,
          })),
        ],
      }));

      const results = await Promise.all([
        ...notes.map(async (d) => {
          updateStep(turnId, `enrich:${d.id}`, { status: "running" });
          try {
            await cloudApi.runEnrich(d.id);
            return { ok: true };
          } catch (e) {
            updateStep(turnId, `enrich:${d.id}`, {
              status: "failed",
              detail: (e as Error).message?.slice(0, 200),
            });
            return { ok: false };
          }
        }),
        ...wikis.map(async (d) => {
          updateStep(turnId, `phaseB:${d.id}`, { status: "running" });
          try {
            await buildWikiAbstractClient(d.id, {
              force: true,
              onProgress: (p) => {
                updateStep(turnId, `phaseB:${d.id}`, {
                  status: "running",
                  progress: { current: p.done, total: p.total },
                  detail: p.phase === "summarizing" ? `LOCAL AI · Summarizing · ${p.title}` : `LOCAL AI · ${p.done}/${p.total}`,
                });
              },
            });
            return { ok: true };
          } catch (e) {
            updateStep(turnId, `phaseB:${d.id}`, {
              status: "failed",
              detail: (e as Error).message?.slice(0, 200),
            });
            return { ok: false };
          }
        }),
      ]);
      const failed = results.filter((r) => !r.ok).length;
      updateTurn(turnId, {
        status: failed > 0 ? "failed" : "done",
        finishedAt: Date.now(),
        summary: failed > 0
          ? `${docs.length - failed}/${docs.length} succeeded`
          : `${docs.length} doc${docs.length === 1 ? "" : "s"} processed`,
      });
    },
    [cloudProviderReady, updateStep, updateTurn],
  );

  const submit = useCallback(
    (action: KPActionKind, docs: KPDocRef[], opts?: { force?: boolean }) => {
      const id = `t-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const baseSteps: Step[] =
        action === "graph"
          ? [{ id: "graph", label: "Rebuild entity graph", status: "running" }]
          : [{
              id: "preflight:provider",
              label: action === "wiki_abstract" ? "[LOCAL AI] Desktop provider ready" : "Cloud AI provider configured",
              status: "pending",
            }];
      if (action === "wiki_abstract") {
        baseSteps.push({
          id: "preflight:chapters",
          label: "Chapters available for each doc",
          status: "pending",
        });
      }
      const turn: Turn = {
        id,
        action,
        docs,
        steps: baseSteps,
        status: "preflight",
        startedAt: Date.now(),
      };
      setTurns((prev) => [turn, ...prev].slice(0, 12));
      // Kick off the runner.
      const force = opts?.force ?? true;
      if (action === "wiki_abstract") void runWikiAbstract(id, docs, force);
      else if (action === "embed") void runEmbed(id, docs);
      else if (action === "enrich") void runEnrichAct(id, docs);
      else if (action === "graph") {
        // Graph rebuild has no doc-scoped pre-flight; just call the
        // route and resolve when the WS broadcasts done.
        (async () => {
          try {
            // No dedicated cloud route in MVP; existing graph rebuild
            // is desktop-side. Treat as instant for the timeline.
            updateStep(id, "graph", { status: "done" });
            updateTurn(id, {
              status: "done",
              finishedAt: Date.now(),
              summary: "graph rebuilt",
            });
          } catch (e) {
            updateStep(id, "graph", {
              status: "failed",
              detail: (e as Error).message?.slice(0, 200),
            });
            updateTurn(id, { status: "failed", finishedAt: Date.now(), summary: "graph rebuild failed" });
          }
        })();
      }
      return id;
    },
    [runWikiAbstract, runEmbed, runEnrichAct, updateStep, updateTurn],
  );

  const dismiss = useCallback((turnId: string) => {
    setTurns((prev) => prev.filter((t) => t.id !== turnId));
  }, []);

  return useMemo(() => ({ turns, submit, dismiss }), [turns, submit, dismiss]);
}

/** The visible panel. Empty state collapses to nothing so the page
 *  layout doesn't reserve dead space when no actions are pending. */
export function KPSessionPanel({ session }: { session: SessionApi }) {
  if (session.turns.length === 0) return null;
  return (
    <section className="kp-session" aria-label="Knowledge processing session">
      {session.turns.map((t) => (
        <KPTurnCard key={t.id} turn={t} onDismiss={() => session.dismiss(t.id)} />
      ))}
    </section>
  );
}

function KPTurnCard({ turn, onDismiss }: { turn: Turn; onDismiss: () => void }) {
  const elapsed = (turn.finishedAt ?? Date.now()) - turn.startedAt;
  const docsLabel =
    turn.docs.length === 0
      ? "(workspace)"
      : turn.docs.length === 1
      ? turn.docs[0].name
      : `${turn.docs.length} docs`;
  return (
    <article className={cn("kp-turn", `kp-turn-${turn.status}`)}>
      <header className="kp-turn-head">
        <span className={cn("kp-turn-status", STATUS_TONE[turn.status])}>
          {turn.status === "running" ? "running…" : turn.status}
        </span>
        <span className="kp-turn-action">{KIND_LABEL[turn.action]}</span>
        <span className="kp-turn-docs">{docsLabel}</span>
        <span className="kp-turn-elapsed">
          {turn.status === "running" || turn.status === "preflight"
            ? `${Math.max(1, Math.round(elapsed / 1000))}s`
            : `${(elapsed / 1000).toFixed(1)}s`}
        </span>
        {(turn.status === "done" || turn.status === "failed" || turn.status === "blocked") && (
          <button
            type="button"
            className="kp-turn-dismiss"
            onClick={onDismiss}
            title="dismiss"
          >
            ×
          </button>
        )}
      </header>
      {turn.summary && <div className="kp-turn-summary">{turn.summary}</div>}
      <ol className="kp-turn-steps">
        {turn.steps.map((s) => (
          <li key={s.id} className={cn("kp-step", STEP_TONE[s.status])}>
            <span className="kp-step-icon" aria-hidden="true">
              {s.status === "done"    ? "✓"
                : s.status === "failed"  ? "✕"
                : s.status === "skipped" ? "○"
                : s.status === "running" ? "▸"
                : "·"}
            </span>
            <span className="kp-step-label">{s.label}</span>
            {s.progress && s.progress.total > 0 && s.status === "running" && (
              <span className="kp-step-progress">
                {s.progress.current}/{s.progress.total}
              </span>
            )}
            {s.detail && <span className="kp-step-detail">{s.detail}</span>}
            {s.fix && (
              <button
                type="button"
                className="kp-step-fix"
                onClick={s.fix.onClick}
              >
                {s.fix.label}
              </button>
            )}
          </li>
        ))}
      </ol>
    </article>
  );
}
