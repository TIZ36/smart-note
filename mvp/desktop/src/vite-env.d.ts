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
    };
  }
}
