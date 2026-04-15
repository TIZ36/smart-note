import { useState, useRef, useEffect } from "react";
import type { SearchResult } from "../lib/types";
import { fetchSearchHistory, type ChatHistoryItem } from "../lib/api";

export type ConversationTurn = {
  role: "user" | "assistant";
  content: string;
  answerId?: number;
  feedbackGiven?: boolean;
  timestamp: number;
};

export type HistoryEntry = {
  query: string;
  resultCount: number;
  timestamp: number;
};

export type SearchState = {
  query: string;
  setQuery: (q: string) => void;
  activeQuery: string;
  setActiveQuery: (q: string) => void;
  recallResults: SearchResult[];
  setRecallResults: (r: SearchResult[]) => void;
  rerankedResults: SearchResult[];
  setRerankedResults: (r: SearchResult[]) => void;
  conversation: ConversationTurn[];
  setConversation: React.Dispatch<React.SetStateAction<ConversationTurn[]>>;
  relatedQuestions: string[];
  setRelatedQuestions: (q: string[]) => void;
  previewRef: string | null;
  setPreviewRef: (r: string | null) => void;
  isAdaptive: boolean;
  setIsAdaptive: (v: boolean) => void;
  hasSearched: boolean;
  setHasSearched: (v: boolean) => void;
  aiEnabled: boolean;
  setAiEnabled: (v: boolean) => void;
  tagFilter: string | null;
  setTagFilter: (v: string | null) => void;
  selectedWiki: string[];
  setSelectedWiki: React.Dispatch<React.SetStateAction<string[]>>;
  topK: number;
  setTopK: (v: number) => void;
  recallLimit: number;
  setRecallLimit: (v: number) => void;
  searchHistory: HistoryEntry[];
  setSearchHistory: React.Dispatch<React.SetStateAction<HistoryEntry[]>>;
  lastEvidenceIds: React.MutableRefObject<number[]>;
  getChatHistory: () => ChatHistoryItem[];
};

export function useSearchState(): SearchState {
  const [query, setQuery] = useState("");
  const [activeQuery, setActiveQuery] = useState("");
  const [recallResults, setRecallResults] = useState<SearchResult[]>([]);
  const [rerankedResults, setRerankedResults] = useState<SearchResult[]>([]);
  const [conversation, setConversation] = useState<ConversationTurn[]>([]);
  const [relatedQuestions, setRelatedQuestions] = useState<string[]>([]);
  const [previewRef, setPreviewRef] = useState<string | null>(null);
  const [isAdaptive, setIsAdaptive] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [selectedWiki, setSelectedWiki] = useState<string[]>([]);
  const [topK, setTopK] = useState(10);
  const [recallLimit, setRecallLimit] = useState(200);
  const [aiEnabled, setAiEnabled] = useState(true);
  const [searchHistory, setSearchHistory] = useState<HistoryEntry[]>([]);
  const lastEvidenceIds = useRef<number[]>([]);

  // Load search history from backend on mount
  useEffect(() => {
    fetchSearchHistory()
      .then((d) => setSearchHistory(d.history.map((h) => ({ query: h.query, resultCount: h.result_count, timestamp: new Date(h.created_at).getTime() }))))
      .catch(() => {});
  }, []);

  function getChatHistory(): ChatHistoryItem[] {
    return conversation.slice(-6).map((t) => ({
      role: t.role,
      content: t.content,
    }));
  }

  return {
    query, setQuery,
    activeQuery, setActiveQuery,
    recallResults, setRecallResults,
    rerankedResults, setRerankedResults,
    conversation, setConversation,
    relatedQuestions, setRelatedQuestions,
    previewRef, setPreviewRef,
    isAdaptive, setIsAdaptive,
    hasSearched, setHasSearched,
    aiEnabled, setAiEnabled,
    tagFilter, setTagFilter,
    selectedWiki, setSelectedWiki,
    topK, setTopK,
    recallLimit, setRecallLimit,
    searchHistory, setSearchHistory,
    lastEvidenceIds,
    getChatHistory,
  };
}
