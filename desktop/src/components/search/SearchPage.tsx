import { useState, useCallback, useRef, useEffect } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Sparkles, Zap, Send, BookOpen, MessageSquare } from "lucide-react";
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
  const [availableWiki, setAvailableWiki] = useState<string[]>([]);

  // Load available wiki topics on mount
  useEffect(() => {
    api.fetchSpecialKnowledge()
      .then((d) => setAvailableWiki(d.topics.map((t) => t.topic)))
      .catch(() => {});
  }, []);

  const [stages, setStages] = useState<Stages>({
    recall: { status: "idle" },
    rerank: { status: "idle" },
    answer: { status: "idle" },
  });
  const [followUp, setFollowUp] = useState("");
  const [highlightIdx, setHighlightIdx] = useState<number | null>(null);
  const [wikiTopicsFound, setWikiTopicsFound] = useState<Record<string, number>>({});
  const cachedSourceFiles = useRef<string[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);

  function handleWikiToggle(topic: string) {
    s.setSelectedWiki((prev) =>
      prev.includes(topic) ? prev.filter((t) => t !== topic) : [...prev, topic]
    );
  }

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
      setWikiTopicsFound({});
      cachedSourceFiles.current = [];

      // Stage 1: Recall
      // When @topic is selected, use it as tag_filter for focused wiki lookup
      setStages({ recall: { status: "running" }, rerank: { status: "idle" }, answer: { status: "idle" } });
      let recallData: SearchResponse;
      const effectiveTagFilter = s.selectedWiki.length === 1 ? `wiki:${s.selectedWiki[0]}` : s.tagFilter;
      try {
        recallData = await api.search(searchQuery, s.recallLimit, effectiveTagFilter);
      } catch {
        setStages((st) => ({ ...st, recall: { status: "error" } }));
        return;
      }
      s.setRecallResults(recallData.results);
      s.setIsAdaptive(recallData.is_adaptive || false);
      setWikiTopicsFound(recallData.wiki_topics_found || {});
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
        } catch {
          setStages((st) => ({ ...st, rerank: { status: "error" } }));
        }
      }
    },
    [s]
  );

  /** Ask AI — auto-includes all wiki results, caches source_files for follow-ups */
  async function handleAskAI() {
    if (stages.answer.status === "running") return;
    const searchQuery = s.activeQuery;
    if (!searchQuery) return;

    // Auto-include all wiki chunk IDs + note evidence
    const allWikiIds = s.recallResults
      .filter((r) => (r.is_wiki || r.dimension?.startsWith("wiki:")) && typeof r.id === "number")
      .map((r) => r.id as number);
    const allEvidenceIds = [...new Set([...s.lastEvidenceIds.current, ...allWikiIds])];

    s.setConversation([]);
    s.setRelatedQuestions([]);
    cachedSourceFiles.current = [];
    setStages((st) => ({ ...st, answer: { status: "running" } }));
    try {
      const chatData = await api.chat(searchQuery, allEvidenceIds, []);
      // Cache source_files for deep follow-ups
      cachedSourceFiles.current = chatData.source_files || [];

      const userTurn: ConversationTurn = { role: "user", content: searchQuery, timestamp: Date.now() };
      const aiTurn: ConversationTurn = { role: "assistant", content: chatData.answer, answerId: chatData.answer_id, timestamp: Date.now() };
      s.setConversation([userTurn, aiTurn]);
      setStages((st) => ({ ...st, answer: { status: "done", ms: chatData.latency_ms } }));

      // Show source hint if we have cached files for deeper follow-up
      if (cachedSourceFiles.current.length > 0) {
        const fileNames = cachedSourceFiles.current.map((f) => f.split("/").pop()).join(", ");
        s.setRelatedQuestions([`Tell me more details from ${fileNames}`]);
      }
    } catch {
      setStages((st) => ({ ...st, answer: { status: "error" } }));
    }
  }

  async function handleFollowUp() {
    const q = followUp.trim();
    if (!q || stages.answer.status === "running") return;
    setFollowUp("");

    const userTurn: ConversationTurn = { role: "user", content: q, timestamp: Date.now() };
    s.setConversation((prev) => [...prev, userTurn]);

    setStages((st) => ({ ...st, answer: { status: "running" } }));
    // Scroll to show loading dots
    setTimeout(() => scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" }), 50);
    try {
      const history = s.getChatHistory();
      // Follow-up uses cached source_files — backend reads full docs for deep context
      const chatData = await api.chat(q, s.lastEvidenceIds.current, history, cachedSourceFiles.current);
      const aiTurn: ConversationTurn = { role: "assistant", content: chatData.answer, answerId: chatData.answer_id, timestamp: Date.now() };
      s.setConversation((prev) => [...prev, aiTurn]);
      setStages((st) => ({ ...st, answer: { status: "done", ms: chatData.latency_ms } }));
      // Update source cache if new sources found
      if (chatData.source_files && chatData.source_files.length > 0) {
        cachedSourceFiles.current = chatData.source_files;
      }
    } catch {
      const errTurn: ConversationTurn = { role: "assistant", content: "Request failed.", timestamp: Date.now() };
      s.setConversation((prev) => [...prev, errTurn]);
      setStages((st) => ({ ...st, answer: { status: "error" } }));
    }

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

  // Unified sorted results, split into notes and wiki
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
  const noteResults = displayResults.filter((r) => !r.is_wiki && !r.dimension?.startsWith("wiki:")).slice(0, s.topK);
  const wikiResults = displayResults.filter((r) => r.is_wiki || r.dimension?.startsWith("wiki:")).slice(0, s.topK);
  const isSearching = stages.recall.status === "running";
  const suggestTopics = Object.entries(wikiTopicsFound).filter(([t]) => !s.selectedWiki.includes(t));

  return (
    <div className="flex flex-col h-full min-h-0">
      {!s.hasSearched ? (
        /* ── Empty state ── */
        <div className="proto-search-empty">
          <div className="proto-search-empty-inner">
            <div className="proto-search-bar-row">
              <div className="proto-search-bar-row-input">
                <SearchBar value={s.query} onChange={s.setQuery} onSubmit={() => handleSearch()} onTab={handleTabCycle} loading={isSearching} tagFilter={s.tagFilter} selectedWiki={s.selectedWiki} availableWiki={availableWiki} onWikiToggle={handleWikiToggle} />
              </div>
              <button type="button" onClick={() => s.setAiEnabled(!s.aiEnabled)} className={cn("proto-ai-toggle", s.aiEnabled ? "proto-ai-toggle-on" : "proto-ai-toggle-off")}>
                {s.aiEnabled ? <Sparkles /> : <Zap />}
                {s.aiEnabled ? "AI" : "OFF"}
              </button>
            </div>
            <div className="proto-search-controls">
              <div className="proto-topk-picker">
                <span className="proto-topk-label">Top</span>
                {[5, 10, 20, 50].map((k) => (
                  <button key={k} type="button" onClick={() => s.setTopK(k)} className={cn("proto-topk-option", s.topK === k && "proto-topk-option-active")}>
                    {k}
                  </button>
                ))}
              </div>
              <div className="proto-topk-picker">
                <span className="proto-topk-label">Recall</span>
                {[50, 100, 200, 500].map((k) => (
                  <button key={k} type="button" onClick={() => s.setRecallLimit(k)} className={cn("proto-topk-option", s.recallLimit === k && "proto-topk-option-active")}>
                    {k}
                  </button>
                ))}
              </div>
            </div>
            <p className="proto-search-hint">Search across your notes & wiki with full-text and semantic matching.</p>

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
            <div className="proto-results-topbar-row">
              <div className="proto-results-topbar-search">
                <SearchBar value={s.query} onChange={s.setQuery} onSubmit={() => handleSearch()} onTab={handleTabCycle} loading={isSearching} tagFilter={s.tagFilter} selectedWiki={s.selectedWiki} availableWiki={availableWiki} onWikiToggle={handleWikiToggle} />
              </div>
              <div className="proto-topk-picker">
                <span className="proto-topk-label">Top</span>
                {[5, 10, 20, 50].map((k) => (
                  <button key={k} type="button" onClick={() => { s.setTopK(k); }} className={cn("proto-topk-option", s.topK === k && "proto-topk-option-active")}>
                    {k}
                  </button>
                ))}
              </div>
              <div className="proto-topk-picker">
                <span className="proto-topk-label">Recall</span>
                {[50, 100, 200, 500].map((k) => (
                  <button key={k} type="button" onClick={() => { s.setRecallLimit(k); handleSearch(); }} className={cn("proto-topk-option", s.recallLimit === k && "proto-topk-option-active")}>
                    {k}
                  </button>
                ))}
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
                                  <button type="button" onClick={() => handleFeedback(turn.answerId!)} disabled={turn.feedbackGiven} className={cn(turn.feedbackGiven && "proto-feedback-given")}>
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

                    {/* Loading dots — shown whenever AI is generating a response */}
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
                    <button type="button" onClick={handleFollowUp} disabled={!followUp.trim() || stages.answer.status === "running"} className="proto-btn proto-btn-primary">
                      <Send size={14} />
                    </button>
                  </div>
                </div>
              )}

              {/* AI loading skeleton (manual trigger in progress) */}
              {s.aiEnabled && stages.answer.status === "running" && s.conversation.length === 0 && (
                <div className="proto-answer-section">
                  <AnswerPanel answer={null} loading={true} answerId={null} feedbackGiven={false} onFeedback={() => {}} />
                </div>
              )}

              {/* Manual "Ask AI" button — shown when AI is on, results exist, no conversation yet */}
              {s.aiEnabled && s.conversation.length === 0 && stages.answer.status !== "running" && stages.rerank.status === "done" && (
                <div className="proto-ask-ai-row">
                  <button type="button" onClick={handleAskAI} className="proto-btn proto-btn-primary proto-ask-ai-btn">
                    <MessageSquare size={14} />
                    Ask AI
                  </button>
                </div>
              )}

              {s.relatedQuestions.length > 0 && (
                <RelatedQuestions questions={s.relatedQuestions} onSelect={(q) => handleSearch(q)} />
              )}

              {/* Note Sources — card grid */}
              {noteResults.length > 0 && (
                <div className="proto-sources-section">
                  <p className="proto-sources-label">Sources ({noteResults.length})</p>
                  <div className="proto-sources-cards">
                    {noteResults.map((r, i) => (
                      <div key={r.id} id={`source-card-${i + 1}`}>
                        <SourceCard
                          index={i + 1}
                          result={r}
                          starred={i < 3}
                          highlighted={s.previewRef === r.source_ref || highlightIdx === i + 1}
                          onClick={r.source_ref?.startsWith("memory:") ? undefined : () => s.setPreviewRef(r.source_ref)}
                        />
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Auto-suggest: topics found in wiki */}
              {suggestTopics.length > 0 && (
                <div className="proto-wiki-suggest">
                  <BookOpen size={14} className="proto-wiki-badge-icon" />
                  <span>Also found in wiki:</span>
                  {suggestTopics.map(([topic, count]) => (
                    <span key={topic} className="proto-wiki-suggest-topic" onClick={() => handleWikiToggle(topic)}>
                      @{topic} ({count})
                    </span>
                  ))}
                </div>
              )}

              {/* Wiki Sources */}
              {wikiResults.length > 0 && (
                <div className="proto-sources-section">
                  <p className="proto-sources-label proto-sources-label-icon">
                    <BookOpen size={14} className="proto-wiki-badge-icon" />
                    Wiki ({wikiResults.length})
                    {s.aiEnabled && <span className="proto-wiki-auto-hint">auto-included in AI</span>}
                  </p>
                  <div className="proto-sources-grid">
                    {wikiResults.map((r, i) => {
                      const globalIdx = noteResults.length + i + 1;
                      return (
                        <div key={r.id} id={`source-card-${globalIdx}`}>
                          <SourceCard
                            index={globalIdx}
                            result={r}
                            highlighted={s.previewRef === r.source_ref || highlightIdx === globalIdx}
                            onClick={r.source_ref?.startsWith("memory:") ? undefined : () => s.setPreviewRef(r.source_ref)}
                          />
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {isSearching && displayResults.length === 0 && (
                <div className="proto-sources-section">
                  <p className="proto-sources-label">Sources</p>
                  <div className="proto-sources-grid">
                    {[1, 2, 3, 4].map((i) => (
                      <div key={i} className="proto-source-skeleton animate-shimmer" />
                    ))}
                  </div>
                </div>
              )}
            </div>

            <AnimatePresence>
              {s.previewRef && (
                <motion.div
                  className="proto-preview-slide"
                  initial={{ width: 0 }}
                  animate={{ width: 340 }}
                  exit={{ width: 0 }}
                  transition={{ duration: 0.18, ease: [0.25, 0.1, 0.25, 1] }}
                >
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
