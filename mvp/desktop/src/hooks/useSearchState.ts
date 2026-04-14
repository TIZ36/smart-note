import { useState, useRef, useEffect } from "react";
import type { SearchResult } from "../lib/types";
import type { ChatHistoryItem } from "../lib/api";

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
  const [aiEnabled, setAiEnabled] = useState(true);
  const [searchHistory, setSearchHistory] = useState<HistoryEntry[]>(() => {
    try {
      const saved = localStorage.getItem("intellinote-search-history");
      return saved ? JSON.parse(saved) : [];
    } catch { return []; }
  });
  const lastEvidenceIds = useRef<number[]>([]);

  useEffect(() => {
    try { localStorage.setItem("intellinote-search-history", JSON.stringify(searchHistory.slice(0, 20))); } catch {}
  }, [searchHistory]);

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
    searchHistory, setSearchHistory,
    lastEvidenceIds,
    getChatHistory,
  };
}
