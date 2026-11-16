import { useCallback, useEffect, useRef, useState } from 'react';

export interface ApiQuery<T> {
  data: T | undefined;
  loading: boolean;
  error: string | null;
  reload: () => void;
}

/**
 * Runs an API call and tracks loading / error state. Re-runs when `deps` change.
 * Keeps previous data visible while reloading; never substitutes fallback values on failure.
 */
export function useApiQuery<T>(fetcher: () => Promise<T>, deps: unknown[]): ApiQuery<T> {
  const [data, setData] = useState<T | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    fetcherRef
      .current()
      .then((d) => {
        if (active) setData(d);
      })
      .catch((err: unknown) => {
        if (!active) return;
        setData(undefined);
        setError(err instanceof Error ? err.message : 'Request failed.');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, loading, error, reload };
}
