import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import type { Artifact, Turn } from "../../../server/types";
import { api, postStream } from "../lib/api";
import { useDocumentTitle } from "../lib/hooks";
import { Link, useRouter } from "../lib/router";
import { useStore } from "../lib/store";
import { renderMarkdown } from "../lib/markdown";
import { ArtifactView } from "../components/Artifacts";
import { useToast } from "../components/ui";
import { IconArrowUp, IconDatabase, IconPlus, IconSpark, IconStop, IconTrash, IconWarn, IconRefresh } from "../components/Icons";

interface Conversation { id: string; title: string; mode: string; updated_at: string; questions?: number }
interface Live { text: string; tools: string[]; artifacts: Artifact[]; status: string | null; error: string | null }

const MAX_LEN = 2000;
const STARTERS: { title: string; items: string[] }[] = [
  { title: "Status", items: ["Give me a portfolio summary for this month", "What is the status of the Konark project?", "How is Madhya Pradesh doing?"] },
  { title: "Delays & risks", items: ["Which projects are delayed by more than 90 days?", "Which works have stalled and why?", "Top 5 riskiest projects and what's driving the risk"] },
  { title: "Money", items: ["Show cost overruns above 15%", "How much has been released but not spent?", "Compare schemes by forecast overrun"] },
  { title: "Actions", items: ["What corrective measures do the top 3 risky projects need?", "Milestones due in the next 30 days that are at risk", "Which progress reports are overdue?"] },
];

export function Assistant({ convId }: { convId: string | null }) {
  useDocumentTitle("Ask Yatra");
  const { navigate, search } = useRouter();
  const { health, index } = useStore();
  const toast = useToast();
  const [convs, setConvs] = useState<Conversation[] | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [loadingConv, setLoadingConv] = useState(false);
  const [convError, setConvError] = useState<string | null>(null);
  const [live, setLive] = useState<Live | null>(null);
  const [input, setInput] = useState("");
  const abortRef = useRef<AbortController | null>(null);
  const ownedId = useRef<string | null>(null);
  const threadRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const autoAsked = useRef<string | null>(null);

  const loadConvs = useCallback(() => api<Conversation[]>("/api/conversations").then(setConvs).catch(() => setConvs([])), []);
  useEffect(() => { loadConvs(); }, [loadConvs]);

  useEffect(() => {
    if (!convId) { setTurns([]); setConvError(null); return; }
    if (ownedId.current === convId) return; // we just created it and hold the turns locally
    setLoadingConv(true);
    setConvError(null);
    api<{ turns: Turn[] }>(`/api/conversations/${convId}`)
      .then((c) => setTurns(c.turns))
      .catch((e) => setConvError(e.status === 404 ? "This conversation no longer exists." : e.message))
      .finally(() => setLoadingConv(false));
  }, [convId]);

  // Keep the view pinned to the bottom while streaming, unless the user scrolled up.
  useLayoutEffect(() => {
    const el = threadRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [turns, live]);
  const onScroll = () => {
    const el = threadRef.current;
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  const send = useCallback(async (raw: string) => {
    const question = raw.trim().slice(0, MAX_LEN);
    if (!question || live) return;
    let id = convId;
    if (!id) {
      try {
        const c = await api<Conversation>("/api/conversations", { method: "POST" });
        id = c.id;
        ownedId.current = id;
        navigate(`/assistant/${id}`, { replace: true });
      } catch (e) {
        toast((e as Error).message, "err");
        return;
      }
    } else {
      ownedId.current = id;
    }
    setInput("");
    stick.current = true;
    setTurns((t) => [...t, { id: -Date.now(), role: "user", text: question, artifacts: [], meta: {}, created_at: new Date().toISOString() }]);
    const state: Live = { text: "", tools: [], artifacts: [], status: null, error: null };
    setLive({ ...state });
    const ac = new AbortController();
    abortRef.current = ac;
    let done = false;
    try {
      await postStream(`/api/conversations/${id}/messages`, { question }, {
        onEvent: (ev, data) => {
          if (ev === "text") state.text += data.delta ?? "";
          else if (ev === "tool") state.tools = [...state.tools, data.label];
          else if (ev === "artifact") state.artifacts = [...state.artifacts, data.artifact];
          else if (ev === "status") state.status = data.message;
          else if (ev === "reset") { state.text = ""; state.artifacts = []; state.status = "Claude was unavailable — switched to offline analysis"; }
          else if (ev === "error") state.error = data.message ?? "Something went wrong.";
          else if (ev === "done") {
            done = true;
            setTurns((t) => [...t, data.turn]);
            setLive(null);
            return;
          }
          setLive({ ...state });
        },
      }, ac.signal);
      if (!done) {
        if (ac.signal.aborted) {
          setTurns((t) => [...t, { id: -Date.now(), role: "assistant", text: state.text || "_Stopped before an answer was ready._", artifacts: state.artifacts, meta: { notice: "Stopped — this partial answer wasn't saved." }, created_at: new Date().toISOString() }]);
          setLive(null);
        } else {
          setLive({ ...state, error: state.error ?? "The connection closed before the answer finished. Try again." });
        }
      }
    } catch (e) {
      setLive({ ...state, error: (e as Error).message });
    } finally {
      abortRef.current = null;
      loadConvs();
    }
  }, [convId, live, navigate, toast, loadConvs]);

  // ?q=... from the overview's ask box or a project page.
  useEffect(() => {
    const q = search.get("q");
    if (q && autoAsked.current !== q && !live) {
      autoAsked.current = q;
      if (convId) navigate(`/assistant/${convId}`, { replace: true });
      send(q);
    }
  }, [search, convId, live, send, navigate]);

  const retry = () => {
    const lastUser = [...turns].reverse().find((t) => t.role === "user");
    setLive(null);
    if (lastUser) {
      setTurns((t) => t.filter((x) => x !== lastUser));
      setTimeout(() => send(lastUser.text), 0);
    }
  };

  const del = async (c: Conversation) => {
    if (!window.confirm(`Delete "${c.title}"? This can't be undone.`)) return;
    try {
      await api(`/api/conversations/${c.id}`, { method: "DELETE" });
      if (c.id === convId) navigate("/assistant");
      loadConvs();
      toast("Conversation deleted.");
    } catch (e) {
      toast((e as Error).message, "err");
    }
  };

  const newChat = () => {
    abortRef.current?.abort();
    ownedId.current = null;
    setLive(null);
    navigate("/assistant");
    setTimeout(() => document.getElementById("composer")?.focus(), 30);
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send(input);
    }
  };
  const offline = health && !health.llm.configured;
  const empty = !convId && turns.length === 0 && !live;

  return (
    <div className="assistant">
      <aside className="conv-list" aria-label="Conversations">
        <button className="btn btn-secondary" onClick={newChat} style={{ marginBottom: 12 }}><IconPlus size={16} />Start a conversation</button>
        {convs === null ? <p className="small muted" style={{ padding: 8 }}>Loading…</p> : convs.length === 0 ? <p className="small muted" style={{ padding: 8 }}>Your questions will be saved here.</p> : convs.map((c) => (
          <div key={c.id} className="conv-item" aria-current={c.id === convId ? "page" : undefined} style={{ padding: 0 }}>
            <Link to={`/assistant/${c.id}`} className="conv-item" style={{ flex: 1, minWidth: 0, color: "inherit", background: "none" }} title={c.title}>
              <span>{c.title}</span>
            </Link>
            <button className="btn btn-ghost btn-icon btn-sm" aria-label={`Delete conversation ${c.title}`} onClick={() => del(c)}><IconTrash size={14} /></button>
          </div>
        ))}
      </aside>

      <div className="thread-col">
        <div className="thread" ref={threadRef} onScroll={onScroll} aria-live="polite" aria-busy={Boolean(live)}>
          <div className="thread-inner">
            {offline && (
              <div className="notice" role="note"><IconWarn size={18} /><div><strong>Offline analysis mode.</strong> Answers come from a built-in rule engine over the same live data. It handles common questions about delays, costs, milestones, funds and projects. For open-ended questions and richer reasoning, add an <code>ANTHROPIC_API_KEY</code> to <code>.env</code> and restart the server.</div></div>
            )}
            {empty && <Welcome onPick={send} multilingual={Boolean(health?.llm.configured)} />}
            {convError && <div className="error-box" role="alert"><IconWarn size={18} /><div style={{ flex: 1 }}>{convError}</div><button className="btn btn-secondary btn-sm" onClick={newChat}>Start a new conversation</button></div>}
            {loadingConv && <p className="muted small">Loading conversation…</p>}
            {turns.map((t, i) => t.role === "user" ? (
              <div key={t.id} className="stack" style={{ gap: 8 }}>
                <div className="msg-user fade-in">{t.text}</div>
                {i === turns.length - 1 && !live && t.id > 0 && <p className="small muted" style={{ alignSelf: "flex-end" }}>No answer was saved for this question. <button className="btn btn-ghost btn-sm" onClick={() => send(t.text)}>Ask again</button></p>}
                {turns[i + 1]?.role === "user" && <p className="small muted" style={{ alignSelf: "flex-end" }}>Not answered.</p>}
              </div>
            ) : (
              <AssistantMsg key={t.id} text={t.text} artifacts={t.artifacts} meta={t.meta} index={index} />
            ))}
            {live && (
              <div className="msg-ai fade-in">
                <div className="avatar" aria-hidden="true"><IconSpark size={16} /></div>
                <div className="body">
                  {live.tools.length > 0 && <div className="tool-trail" aria-label="Steps taken">{live.tools.map((t, i) => <span key={i} className="tool-step"><IconDatabase size={12} /><span>{t}</span></span>)}</div>}
                  {live.status && <p className="small muted">{live.status}</p>}
                  {live.text ? <div className="md" dangerouslySetInnerHTML={{ __html: renderMarkdown(live.text) }} /> : !live.error && <div className="typing" aria-label="Thinking"><i /><i /><i /></div>}
                  {live.artifacts.map((a, i) => <ArtifactView key={i} artifact={a} index={index} />)}
                  {live.error && (
                    <div className="error-box" role="alert">
                      <IconWarn size={18} />
                      <div style={{ flex: 1 }}><strong>The answer didn't complete.</strong><p>{live.error}</p></div>
                      <button className="btn btn-secondary btn-sm" onClick={retry}><IconRefresh size={14} />Try again</button>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="composer-wrap">
          <form className="composer" onSubmit={(e) => { e.preventDefault(); send(input); }}>
            <label htmlFor="composer" className="visually-hidden">Ask a question about the projects</label>
            <textarea id="composer" rows={1} value={input} maxLength={MAX_LEN} placeholder={live ? "Answering…" : "Ask about delays, costs or a project…"}
              onChange={(e) => { setInput(e.target.value); e.target.style.height = "auto"; e.target.style.height = `${Math.min(200, e.target.scrollHeight)}px`; }}
              onKeyDown={onKey} disabled={Boolean(live) && !live?.error} autoFocus />
            {live && !live.error ? (
              <button type="button" className="btn btn-secondary btn-icon" onClick={() => abortRef.current?.abort()} aria-label="Stop answering"><IconStop size={16} /></button>
            ) : (
              <button type="submit" className="btn btn-primary btn-icon" disabled={!input.trim()} aria-label="Send question"><IconArrowUp size={18} /></button>
            )}
          </form>
          <div className="composer-foot">
            <span>{health?.llm.configured ? `Claude · ${health.llm.model}` : "Offline analysis engine"} · answers use live project data; check critical figures before acting.</span>
            <span className="num" aria-live="polite">{input.length > MAX_LEN * 0.8 ? `${input.length}/${MAX_LEN}` : ""}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function AssistantMsg({ text, artifacts, meta, index }: { text: string; artifacts: Artifact[]; meta: Turn["meta"]; index: ReturnType<typeof useStore>["index"] }) {
  return (
    <div className="msg-ai fade-in">
      <div className="avatar" aria-hidden="true"><IconSpark size={16} /></div>
      <div className="body">
        {meta.notice && <div className="notice" role="note"><IconWarn size={16} /><span>{meta.notice}</span></div>}
        <div className="md" dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }} />
        {artifacts.map((a, i) => <ArtifactView key={i} artifact={a} index={index} />)}
        <div className="msg-meta">
          {meta.mode === "claude" ? <span className="badge badge-done"><IconSpark size={12} />Claude</span> : meta.mode === "offline" ? <span className="badge badge-neutral">Offline engine</span> : null}
          {meta.tools && meta.tools.length > 0 && <span>Used: {meta.tools.map((t) => t.replace(/_/g, " ")).join(", ")}</span>}
        </div>
      </div>
    </div>
  );
}

function Welcome({ onPick, multilingual }: { onPick: (q: string) => void; multilingual: boolean }) {
  return (
    <div className="stack fade-in" style={{ gap: 24, paddingTop: "4vh" }}>
      <div>
        <span className="brand-mark" style={{ width: 44, height: 44, borderRadius: 12 }}><IconSpark size={22} /></span>
        <h1 style={{ marginTop: 16 }}>Questions about delays, costs and milestones</h1>
        <p className="muted" style={{ marginTop: 8, maxWidth: "62ch" }}>Ask in plain language{multilingual ? " — in English or Hindi" : ""}. Answers are computed from the latest monthly reports, milestones and issues, with the evidence shown alongside.</p>
      </div>
      <div className="grid grid-2">
        {STARTERS.map((g) => (
          <div key={g.title} className="card card-pad">
            <p className="eyebrow" style={{ marginBottom: 8 }}>{g.title}</p>
            <div className="stack" style={{ gap: 8 }}>
              {g.items.map((q) => <button key={q} className="chip" style={{ justifyContent: "flex-start" }} onClick={() => onPick(q)}>{q}</button>)}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
