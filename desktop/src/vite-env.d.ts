/// <reference types="vite/client" />

export {};

declare global {
  interface Window {
    desktop?: {
      invoke: (channel: string, payload?: unknown) => Promise<unknown>;
      onIngestStatus: (
        callback: (data: {
          status: string;
          step: string;
          current: number;
          total: number;
          elapsed_ms: number;
          message: string;
        }) => void
      ) => () => void;
      onWikiIngestStatus: (
        callback: (data: {
          status: string;
          step: string;
          current: number;
          total: number;
          elapsed_ms: number;
          message: string;
        }) => void
      ) => () => void;
      onHotkeyPasted: (
        callback: (data: { rawPath: string; lineCount: number }) => void
      ) => () => void;
      onWsEvent?: (callback: (data: unknown) => void) => () => void;
      onSpotlightOpen?: (callback: () => void) => () => void;
      onOpenSource?: (callback: (data: { channel: string }) => void) => () => void;
      onAiChatChunk?: (
        callback: (chunk: {
          id: string;
          type: "reasoning" | "content" | "done" | "error";
          text?: string;
          err?: string;
          prompt_tokens?: number;
          completion_tokens?: number;
          total_tokens?: number;
          finish_reason?: string;
        }) => void
      ) => () => void;
    };
  }
}
