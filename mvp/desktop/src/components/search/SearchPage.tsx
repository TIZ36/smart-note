import { useState, useCallback, useRef } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Sparkles, Zap, Send } from "lucide-react";
import ReactMarkdown from "react-markdown";
import { SearchBar } from "./SearchBar";
import { AnswerPanel } from "./AnswerPanel";
import { SourceCard } from "./SourceCard";
import { SourcePreview } from "./SourcePreview";
import { RelatedQuestions } from "./RelatedQuestions";
import { PipelineStatus, type StageStatus } from "./PipelineStatus";
import { cn } from "../../lib/cn";
import * as api from "../../lib/api";
import type { SearchResponse } from "../../lib/types";
import type { SearchState, ConversationTurn } from "../../hooks/useSearchState";

type Stages = {
  recall: { status: StageStatus; count?: number; ms?: number };
  rerank: { status: StageStatus; count?: number; ms?: number };
  answer: { status: StageStatus; ms?: number };
};

type Props = {
  searchState: SearchState;
  tags: { name: string; color?: string }[];
};

export function SearchPage({ searchState: s, tags }: Props) {
  const tagNames = tags.map(t => t.name);
  const tagColorMap = Object.fromEntries(tags.map(t => [t.name, t.color || "gray"]));
  const [stages, setStages] = useState<Stages>({
    recall: { status: "idle" },
    rerank: { status: "idle" },
    answer: { status: "idle" },
  });
  const [followUp, setFollowUp] = useState("");
  const [highlightIdx, setHighlightIdx] = useState<number | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Tab cycles through: All → tag1 → tag2 → ... → All
  function handleTabCycle() {
    const options = [null, ...tagNames];
    const currentIdx = s.tagFilter === null ? 0 : options.indexOf(s.tagFilter);
    const nextIdx = (currentIdx + 1) % options.length;
    s.setTagFilter(options[nextIdx]);
  }

  const handleSearch = useCallback(
    async (q?: string) => {
      const searchQuery = (q || s.query).trim();
      if (!searchQuery) return;
      if (q) s.setQuery(q);
      s.setActiveQuery(searchQuery);
      s.setHasSearched(true);
      s.setRecallResults([]);
      s.setRerankedResults([]);
      s.setConversation([]);
      s.setRelatedQuestions([]);
      s.setPreviewRef(null);
      s.setIsAdaptive(false);
      setFollowUp("");

      // Stage 1: Recall
      setStages({ recall: { status: "running" }, rerank: { status: "idle" }, answer: { status: "idle" } });
      let recallData: SearchResponse;
      try {
        recallData = await api.search(searchQuery, 200, s.tagFilter);
      } catch {
        setStages((st) => ({ ...st, recall: { status: "error" } }));
        return;
      }
      s.setRecallResults(recallData.results);
      s.setIsAdaptive(recallData.is_adaptive || false);
      setStages((st) => ({
        ...st,
        recall: { status: "done", count: recallData.total_recall || recallData.results.length, ms: recallData.latency_ms },
      }));

      // Refresh history from backend (it auto-saves on each search)
      api.fetchSearchHistory()
        .then((d) => s.setSearchHistory(d.history.map((h) => ({ query: h.query, resultCount: h.result_count, timestamp: new Date(h.created_at).getTime() }))))
        .catch(() => {});

      // Stage 2: Rerank
      const chunkIds = recallData.results
        .filter((r) => typeof r.id === "number")
        .map((r) => r.id as number);

      if (chunkIds.length > 0) {
        setStages((st) => ({ ...st, rerank: { status: "running" } }));
        try {
          const rerankData = await api.rerank(searchQuery, chunkIds, false, Math.min(chunkIds.length, 50));
          s.setRerankedResults(rerankData.results);
          setStages((st) => ({
            ...st,
            rerank: { status: "done", count: rerankData.results.length, ms: rerankData.latency_ms },
          }));

          const evidenceIds = rerankData.results
            .filter((r) => typeof r.id === "number")
            .map((r) => r.id as number);
          s.lastEvidenceIds.current = evidenceIds;

          // Stage 3: AI Answer
          if (s.aiEnabled) {
            setStages((st) => ({ ...st, answer: { status: "running" } }));
            try {
              const chatData = await api.chat(searchQuery, evidenceIds, []);
              const userTurn: ConversationTurn = { role: "user", content: searchQuery, timestamp: Date.now() };
              const aiTurn: ConversationTurn = { role: "assistant", content: chatData.answer, answerId: chatData.answer_id, timestamp: Date.now() };
              s.setConversation([userTurn, aiTurn]);
              setStages((st) => ({ ...st, answer: { status: "done", ms: chatData.latency_ms } }));

              const dims = new Set((chatData.evidence || []).map((e) => e.dimension).filter(Boolean));
              const suggestions = [...dims].slice(0, 3).map((dim) => `${dim}相关的其他内容?`);
              if (suggestions.length === 0) suggestions.push(`关于 ${searchQuery} 的更多信息?`);
              s.setRelatedQuestions(suggestions);
            } catch {
              setStages((st) => ({ ...st, answer: { status: "error" } }));
            }
          }
        } catch {
          setStages((st) => ({ ...st, rerank: { status: "error" } }));
        }
      }
    },
    [s]
  );

  async function handleFollowUp() {
    const q = followUp.trim();
    if (!q || stages.answer.status === "running") return;
    setFollowUp("");

    const userTurn: ConversationTurn = { role: "user", content: q, timestamp: Date.now() };
    s.setConversation((prev) => [...prev, userTurn]);

    setStages((st) => ({ ...st, answer: { status: "running" } }));
    try {
      const history = s.getChatHistory();
      const chatData = await api.chat(q, s.lastEvidenceIds.current, history);
      const aiTurn: ConversationTurn = { role: "assistant", content: chatData.answer, answerId: chatData.answer_id, timestamp: Date.now() };
      s.setConversation((prev) => [...prev, aiTurn]);
      setStages((st) => ({ ...st, answer: { status: "done", ms: chatData.latency_ms } }));
    } catch {
      const errTurn: ConversationTurn = { role: "assistant", content: "Request failed.", timestamp: Date.now() };
      s.setConversation((prev) => [...prev, errTurn]);
      setStages((st) => ({ ...st, answer: { status: "error" } }));
    }

    // Scroll to bottom of conversation
    setTimeout(() => scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" }), 100);
  }

  async function handleFeedback(answerId: number) {
    try {
      await api.feedback(answerId, s.activeQuery);
      s.setConversation((prev) =>
        prev.map((t) => (t.answerId === answerId ? { ...t, feedbackGiven: true } : t))
      );
    } catch {}
  }

  function handleCitationClick(index: number) {
    setHighlightIdx(index);
    const el = document.getElementById(`source-card-${index}`);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
    const r = displayResults[index - 1];
    if (r?.source_ref && !r.source_ref.startsWith("memory:")) {
      s.setPreviewRef(r.source_ref);
    }
    setTimeout(() => setHighlightIdx(null), 3000);
  }

  // Unified sorted results
  const displayResults = (() => {
    const addColor = (r: typeof s.recallResults[0]) => ({ ...r, _tagColor: tagColorMap[r.dimension] || "gray" });
    if (s.rerankedResults.length === 0) return s.recallResults.map(addColor);
    const rerankScoreMap = new Map<number | string, number>();
    s.rerankedResults.forEach((r) => {
      rerankScoreMap.set(r.id, r.rerank_score ?? r.score ?? 0);
    });
    return s.recallResults
      .map((r) => ({ ...r, score: rerankScoreMap.get(r.id) ?? r.score ?? 0, _reranked: rerankScoreMap.has(r.id), _tagColor: tagColorMap[r.dimension] || "gray" }))
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  })();
  const isSearching = stages.recall.status === "running";
  const topK = 3;
  const lastAiTurn = [...s.conversation].reverse().find((t) => t.role === "assistant");

  return (
    <div className="flex flex-col h-full min-h-0">
      {!s.hasSearched ? (
        /* ── Empty state ── */
        <div className="proto-search-empty">
          <div className="proto-search-empty-inner">
            <SearchBar value={s.query} onChange={s.setQuery} onSubmit={() => handleSearch()} onTab={handleTabCycle} loading={isSearching} tagFilter={s.tagFilter} />
            <div style={{ display: "flex", justifyContent: "center", marginTop: 12 }}>
              <button type="button" onClick={() => s.setAiEnabled(!s.aiEnabled)} className={cn("proto-ai-toggle", s.aiEnabled ? "proto-ai-toggle-on" : "proto-ai-toggle-off")}>
                {s.aiEnabled ? <Sparkles /> : <Zap />}
                {s.aiEnabled ? "AI Answer ON" : "AI Answer OFF"}
              </button>
            </div>
            <p className="proto-search-hint">Search across your notes with full-text and semantic matching.</p>

            {s.searchHistory.length > 0 && (
              <div className="proto-search-history">
                <div className="proto-search-history-label">Recent</div>
                {s.searchHistory.slice(0, 5).map((h, i) => (
                  <button key={i} type="button" onClick={() => handleSearch(h.query)} className="proto-search-history-item">
                    {h.query}
                    <span className="proto-search-history-meta">{h.resultCount} results</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      ) : (
        /* ── Results ── */
        <>
          <div className="proto-results-topbar shrink-0">
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <SearchBar value={s.query} onChange={s.setQuery} onSubmit={() => handleSearch()} onTab={handleTabCycle} loading={isSearching} tagFilter={s.tagFilter} />
              </div>
              <button type="button" onClick={() => s.setAiEnabled(!s.aiEnabled)} className={cn("proto-ai-toggle", s.aiEnabled ? "proto-ai-toggle-on" : "proto-ai-toggle-off")} title={s.aiEnabled ? "AI enabled" : "AI disabled"}>
                {s.aiEnabled ? <Sparkles /> : <Zap />}
                {s.aiEnabled ? "AI" : "OFF"}
              </button>
            </div>
            <PipelineStatus recall={stages.recall} rerank={stages.rerank} answer={stages.answer} isAdaptive={s.isAdaptive} />
          </div>

          <div className="flex-1 overflow-hidden flex min-h-0">
            <div ref={scrollRef} className="flex-1 overflow-y-auto min-w-0">
              {/* ── Conversation thread ── */}
              {s.aiEnabled && s.conversation.length > 0 && (
                <div className="proto-answer-section">
                  <div className="proto-answer-label">Conversation</div>
                  <div className="proto-conversation-thread">
                    {s.conversation.map((turn, i) => (
                      <div key={i} className={cn("proto-conversation-turn", turn.role === "user" ? "proto-conversation-user" : "proto-conversation-assistant")}>
                        <span className="proto-conversation-role">{turn.role === "user" ? "Q" : "A"}</span>
                        <div className="proto-conversation-content">
                          {turn.role === "assistant" ? (
                            <>
                              <div className="proto-answer-body markdown-content">
                                <ReactMarkdown
                                  components={{
                                    p: ({ children }) => <p>{renderCitations(children, handleCitationClick)}</p>,
                                    li: ({ children }) => <li>{renderCitations(children, handleCitationClick)}</li>,
                                  }}
                                >
                                  {turn.content}
                                </ReactMarkdown>
                              </div>
                              {turn.answerId && (
                                <div className="proto-answer-feedback">
                                  <button type="button" onClick={() => handleFeedback(turn.answerId!)} disabled={turn.feedbackGiven} className={cn(turn.feedbackGiven && "text-[var(--color-success)]")}>
                                    {turn.feedbackGiven ? "Thanks!" : "\u261D Helpful"}
                                  </button>
                                </div>
                              )}
                            </>
                          ) : (
                            <span>{turn.content}</span>
                          )}
                        </div>
                      </div>
                    ))}

                    {/* Loading indicator for pending AI response */}
                    {stages.answer.status === "running" && (
                      <div className="proto-conversation-turn proto-conversation-assistant">
                        <span className="proto-conversation-role">A</span>
                        <div className="proto-conversation-content">
                          <div className="flex items-center gap-1.5">
                            {[0, 1, 2].map((i) => (
                              <motion.div key={i} className="w-1.5 h-1.5 rounded-full bg-[var(--color-text-muted)]" animate={{ opacity: [0.3, 1, 0.3] }} transition={{ repeat: Infinity, duration: 1, delay: i * 0.15 }} />
                            ))}
                          </div>
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Follow-up input */}
                  <div className="proto-followup-row">
                    <input type="text" value={followUp} onChange={(e) => setFollowUp(e.target.value)} onKeyDown={(e) => e.key === "Enter" && handleFollowUp()} placeholder="Ask a follow-up..." className="proto-followup-input" disabled={stages.answer.status === "running"} />
                    <button type="button" onClick={handleFollowUp} disabled={!followUp.trim() || stages.answer.status === "running"} className="proto-btn proto-btn-primary disabled:opacity-30">
                      <Send size={14} />
                    </button>
                  </div>
                </div>
              )}

              {/* AI loading skeleton (first search, no conversation yet) */}
              {s.aiEnabled && stages.answer.status === "running" && s.conversation.length === 0 && (
                <div className="proto-answer-section">
                  <AnswerPanel answer={null} loading={true} answerId={null} feedbackGiven={false} onFeedback={() => {}} />
                </div>
              )}

              {s.relatedQuestions.length > 0 && (
                <RelatedQuestions questions={s.relatedQuestions} onSelect={(q) => handleSearch(q)} />
              )}

              {/* Sources */}
              {displayResults.length > 0 && (
                <div className="proto-sources-section">
                  <p className="proto-sources-label">Sources ({displayResults.length})</p>
                  <div className="proto-sources-grid">
                    {displayResults.map((r, i) => (
                      <div key={r.id} id={`source-card-${i + 1}`}>
                        <SourceCard
                          index={i + 1}
                          result={r}
                          starred={i < topK}
                          highlighted={s.previewRef === r.source_ref || highlightIdx === i + 1}
                          onClick={r.source_ref?.startsWith("memory:") ? undefined : () => s.setPreviewRef(r.source_ref)}
                        />
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {isSearching && displayResults.length === 0 && (
                <div className="proto-sources-section">
                  <p className="proto-sources-label">Sources</p>
                  <div className="proto-sources-grid">
                    {[1, 2, 3, 4].map((i) => (
                      <div key={i} className="h-24 animate-shimmer" style={{ borderRadius: "var(--radius-proto)", border: "1px solid var(--color-border)" }} />
                    ))}
                  </div>
                </div>
              )}
            </div>

            <AnimatePresence>
              {s.previewRef && (
                <motion.div style={{ width: 320, flexShrink: 0, borderLeft: "1px solid var(--color-border)" }} initial={{ width: 0, opacity: 0 }} animate={{ width: 320, opacity: 1 }} exit={{ width: 0, opacity: 0 }} transition={{ duration: 0.15 }}>
                  <SourcePreview sourceRef={s.previewRef} onClose={() => s.setPreviewRef(null)} />
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </>
      )}
    </div>
  );
}

/** Helper: convert [N] in text nodes to clickable citation links */
function renderCitations(children: React.ReactNode, onClick: (idx: number) => void): React.ReactNode {
  if (!Array.isArray(children)) {
    if (typeof children === "string") return <CitationText text={children} onClick={onClick} />;
    return children;
  }
  return children.map((child, i) =>
    typeof child === "string" ? <CitationText key={i} text={child} onClick={onClick} /> : child
  );
}

function CitationText({ text, onClick }: { text: string; onClick: (idx: number) => void }) {
  const parts = text.split(/(\[\d+\])/g);
  return (
    <>
      {parts.map((part, i) => {
        const m = part.match(/^\[(\d+)\]$/);
        if (m) {
          const idx = parseInt(m[1], 10);
          return <button key={i} type="button" onClick={() => onClick(idx)} className="proto-citation-link" title={`Jump to source ${idx}`}>{part}</button>;
        }
        return <span key={i}>{part}</span>;
      })}
    </>
  );
}
