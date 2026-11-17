import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "./api";

export interface Resource<T> {
  data: T | undefined;
  error: ApiError | null;
  loading: boolean; // first load, no data yet
  refreshing: boolean; // reloading while showing previous data
  reload: () => void;
  setData: (d: T) => void;
}

/** Fetch a JSON resource. Keeps the previous data while refetching (no skeleton flash). */
export function useApi<T>(path: string | null): Resource<T> {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<ApiError | null>(null);
  const [pending, setPending] = useState(false);
  const [nonce, setNonce] = useState(0);
  const seq = useRef(0);

  useEffect(() => {
    if (!path) return;
    const id = ++seq.current;
    setPending(true);
    setError(null);
    api<T>(path)
      .then((d) => {
        if (id === seq.current) setData(d);
      })
      .catch((e: ApiError) => {
        if (id === seq.current) setError(e);
      })
      .finally(() => {
        if (id === seq.current) setPending(false);
      });
  }, [path, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { data, error, loading: pending && data === undefined, refreshing: pending && data !== undefined, reload, setData };
}

export function useMediaQuery(q: string): boolean {
  const [m, setM] = useState(() => window.matchMedia(q).matches);
  useEffect(() => {
    const mq = window.matchMedia(q);
    const on = () => setM(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [q]);
  return m;
}

export function useElementWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setW(el.clientWidth);
    const ro = new ResizeObserver(([e]) => setW(Math.round(e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

export function useDocumentTitle(title: string) {
  useEffect(() => {
    document.title = title ? `${title} · Yatra Insight` : "Yatra Insight: project monitoring for tourism officials";
  }, [title]);
}

export function storageGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
export function storageSet(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* private mode */
  }
}
