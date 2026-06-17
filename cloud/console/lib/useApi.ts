"use client";
import { useEffect, useState } from "react";

type State<T> = { data: T | null; error: string | null; loading: boolean };

/** Tiny SWR-substitute: invokes the loader on mount, exposes loading +
 *  error states, and re-runs whenever `deps` change. Add a real SWR /
 *  React Query layer once we need caching, polling, or revalidation. */
export function useApi<T>(loader: () => Promise<T>, deps: unknown[] = []): State<T> & { reload: () => void } {
  const [s, setS] = useState<State<T>>({ data: null, error: null, loading: true });
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let alive = true;
    setS((p) => ({ ...p, loading: true, error: null }));
    loader().then(
      (data) => { if (alive) setS({ data, error: null, loading: false }); },
      (err)  => { if (alive) setS({ data: null, error: String(err?.message || err), loading: false }); },
    );
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);

  return { ...s, reload: () => setNonce((n) => n + 1) };
}
