// Minimal History-API router (no dependency).
import { createContext, useCallback, useContext, useEffect, useState, type AnchorHTMLAttributes, type MouseEvent, type ReactNode } from "react";

interface RouterCtx {
  path: string;
  search: URLSearchParams;
  navigate: (to: string, opts?: { replace?: boolean }) => void;
}

const Ctx = createContext<RouterCtx | null>(null);

export function RouterProvider({ children }: { children: ReactNode }) {
  const [loc, setLoc] = useState(() => ({ path: window.location.pathname, search: window.location.search }));
  useEffect(() => {
    const onPop = () => setLoc({ path: window.location.pathname, search: window.location.search });
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const navigate = useCallback((to: string, opts?: { replace?: boolean }) => {
    const url = new URL(to, window.location.origin);
    if (opts?.replace) window.history.replaceState(null, "", url);
    else window.history.pushState(null, "", url);
    setLoc({ path: url.pathname, search: url.search });
    if (!opts?.replace) window.scrollTo({ top: 0 });
  }, []);
  return <Ctx.Provider value={{ path: loc.path, search: new URLSearchParams(loc.search), navigate }}>{children}</Ctx.Provider>;
}

export function useRouter() {
  const c = useContext(Ctx);
  if (!c) throw new Error("useRouter outside RouterProvider");
  return c;
}

/** Match "/projects/:id" against a path. Returns params or null. */
export function match(pattern: string, path: string): Record<string, string> | null {
  const p = pattern.split("/").filter(Boolean);
  const s = path.split("/").filter(Boolean);
  if (p.length !== s.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < p.length; i++) {
    if (p[i].startsWith(":")) params[p[i].slice(1)] = decodeURIComponent(s[i]);
    else if (p[i] !== s[i]) return null;
  }
  return params;
}

export function Link({ to, children, onClick, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }) {
  const { navigate } = useRouter();
  const handle = (e: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(e);
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || rest.target === "_blank") return;
    e.preventDefault();
    navigate(to);
  };
  return (
    <a href={to} onClick={handle} {...rest}>
      {children}
    </a>
  );
}
