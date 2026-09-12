"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";
import { SEED_DOCS, type JeffDoc } from "@/lib/jeff/demo-data";
import { GRAPH_SOURCES, SOURCES, sourceDef } from "@/lib/jeff/sources";
import { retrieve, extractiveAnswer } from "@/lib/jeff/retrieve";
import { looksSensitiveClient } from "@/lib/security/client-redact";
import type { ConnectionSummary } from "@/lib/integrations/types";

export type Mode = "demo" | "live";

export interface ChatMessage {
  role: "user" | "assistant";
  text: string;
  refs?: JeffDoc[];
  citations?: { title: string; provider?: string; url?: string }[];
  question?: string;
  ai?: boolean;
  toolsUsed?: string[];
}

export interface SavedAnswer {
  id: string;
  question: string;
  text: string;
  savedAt: string;
  mode: string;
}

export interface JeffInitial {
  mode: Mode;
  aiEnabled: boolean;
  aiBudgetUsd: number;
  ownerEmail: string;
  aal: "aal1" | "aal2";
  connections: ConnectionSummary[];
  liveDocs: JeffDoc[];
  notes: JeffDoc[];
  saved: SavedAnswer[];
  missionCount: number;
  approvalCount: number;
  /** Open alerts at or above the owner's minimum importance (live mode). */
  alertCount: number;
}

interface JeffStore extends JeffInitial {
  sources: Set<string>; // demo sample toggles
  focusSource: string | null;
  chatScope: string;
  motion: boolean;
  labels: boolean;
  busy: boolean;
  messages: ChatMessage[];
  agentOpen: boolean;
  sidebarOpen: boolean;
  modal: ReactNode | null;
  toasts: { id: number; text: string }[];
  connectedSources: () => string[];
  docs: () => JeffDoc[];
  toggleSource: (id: string) => void;
  setFocusSource: (id: string | null) => void;
  setChatScope: (id: string) => void;
  setMotion: (v: boolean) => void;
  setAgentOpen: (v: boolean) => void;
  setSidebarOpen: (v: boolean) => void;
  openModal: (node: ReactNode) => void;
  closeModal: () => void;
  toast: (text: string) => void;
  ask: (text: string) => Promise<void>;
  newChat: () => void;
  saveAnswer: (m: ChatMessage) => Promise<void>;
  deleteSaved: (id: string) => Promise<void>;
  addNote: (title: string, content: string, tags: string[]) => Promise<boolean>;
  deleteNote: (id: string) => Promise<void>;
  setMode: (m: Mode) => Promise<void>;
  refreshConnections: () => Promise<void>;
  navigate: (path: string) => void;
}

const Ctx = createContext<JeffStore | null>(null);

function subscribeReducedMotion(cb: () => void) {
  const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
  mq.addEventListener("change", cb);
  return () => mq.removeEventListener("change", cb);
}
function getReducedMotion() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function useJeff(): JeffStore {
  const s = useContext(Ctx);
  if (!s) throw new Error("useJeff must be used inside JeffProvider");
  return s;
}

let toastSeq = 0;

export function JeffProvider({ initial, children }: { initial: JeffInitial; children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [mode, setModeState] = useState<Mode>(initial.mode);
  const [connections, setConnections] = useState(initial.connections);
  const [notes, setNotes] = useState<JeffDoc[]>(initial.mode === "live" ? initial.notes : []);
  const [saved, setSaved] = useState<SavedAnswer[]>(initial.mode === "live" ? initial.saved : []);
  const [sources, setSources] = useState<Set<string>>(() => new Set(GRAPH_SOURCES.map((s) => s.id)));
  const [focusSource, setFocusSource] = useState<string | null>(null);
  const [chatScope, setChatScope] = useState("all");
  const reducedMotion = useSyncExternalStore(subscribeReducedMotion, getReducedMotion, () => false);
  const [motionOverride, setMotion] = useState<boolean | null>(null);
  const motion = motionOverride ?? !reducedMotion;
  const [labels] = useState(true);
  const [busy, setBusy] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [agentOpen, setAgentOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [modal, setModal] = useState<ReactNode | null>(null);
  const [toasts, setToasts] = useState<{ id: number; text: string }[]>([]);
  const lastFocus = useRef<Element | null>(null);

  // Apply wide-page layout for operational views.
  useEffect(() => {
    const wide = ["/missions", "/insights", "/approvals", "/connections", "/security", "/memory"].some((p) => pathname.startsWith(p));
    document.body.classList.toggle("wide-page", wide);
  }, [pathname]);

  const toast = useCallback((text: string) => {
    const id = ++toastSeq;
    setToasts((t) => [...t, { id, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 5000);
  }, []);

  const liveSourceIds = useMemo(() => {
    const ids = new Set<string>();
    for (const c of connections) {
      if (!["connected", "limited"].includes(c.status)) continue;
      for (const s of SOURCES) {
        if (s.provider !== c.provider) continue;
        if (s.capability && c.capabilities.length && !c.capabilities.includes(s.capability)) continue;
        ids.add(s.id);
      }
    }
    if (notes.length) ids.add("notes");
    return [...ids];
  }, [connections, notes.length]);

  const connectedSources = useCallback(() => (mode === "demo" ? [...sources] : liveSourceIds), [mode, sources, liveSourceIds]);

  const docs = useCallback(() => {
    const base = mode === "demo" ? SEED_DOCS : initial.liveDocs;
    const ids = connectedSources();
    return [...base, ...notes].filter((d) => ids.includes(d.source));
  }, [mode, initial.liveDocs, notes, connectedSources]);

  const openModal = useCallback((node: ReactNode) => {
    lastFocus.current = document.activeElement;
    setModal(node);
  }, []);
  const closeModal = useCallback(() => {
    setModal(null);
    const el = lastFocus.current as HTMLElement | null;
    if (el?.isConnected) el.focus();
  }, []);

  const toggleSource = useCallback(
    (id: string) => {
      setSources((prev) => {
        const next = new Set(prev);
        if (next.has(id)) {
          next.delete(id);
          setFocusSource((f) => (f === id ? null : f));
          setChatScope((c) => (c === id ? "all" : c));
        } else next.add(id);
        toast(`${sourceDef(id).name} ${next.has(id) ? "added to" : "removed from"} the sample brain. No account was connected.`);
        return next;
      });
    },
    [toast],
  );

  const navigate = useCallback((path: string) => router.push(path), [router]);

  const ask = useCallback(
    async (text: string) => {
      const q = text.trim();
      if (!q || busy) return;
      if (looksSensitiveClient(q)) {
        toast("Possible credential or private access link detected. Do not put secrets in chat.");
        return;
      }
      closeModal();
      setAgentOpen(true);
      const history = [...messages, { role: "user" as const, text: q }];
      setMessages(history);
      setBusy(true);
      try {
        const refs = retrieve(docs(), q, chatScope, 4);
        if (initial.aiEnabled) {
          const res = await fetch("/api/jeff/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              messages: history.slice(-12).map((m) => ({ role: m.role, content: m.text })),
              context: mode === "demo" ? refs.map((r) => ({ title: r.title, source: r.source, content: r.content.slice(0, 1200) })) : [],
            }),
          });
          const data = (await res.json().catch(() => null)) as { text?: string; citations?: ChatMessage["citations"]; toolsUsed?: string[]; error?: string; hint?: string } | null;
          if (!res.ok || !data?.text) {
            const msg = data?.hint ?? (data?.error ? `Jeff could not answer (${data.error}).` : "Jeff could not answer right now.");
            setMessages([...history, { role: "assistant", text: msg, question: q, ai: true }]);
          } else {
            setMessages([...history, { role: "assistant", text: data.text, refs: mode === "demo" ? refs : [], citations: data.citations, toolsUsed: data.toolsUsed, question: q, ai: true }]);
          }
        } else {
          await new Promise((r) => setTimeout(r, 250));
          setMessages([...history, { role: "assistant", text: extractiveAnswer(q, refs, mode), refs, question: q, ai: false }]);
        }
      } finally {
        setBusy(false);
      }
    },
    [busy, messages, docs, chatScope, initial.aiEnabled, mode, toast, closeModal],
  );

  const newChat = useCallback(() => {
    if (busy) return toast("Let the current answer finish before starting again.");
    setMessages([]);
  }, [busy, toast]);

  const saveAnswer = useCallback(
    async (m: ChatMessage) => {
      if (saved.some((a) => a.text === m.text)) return toast("This answer is already saved.");
      const entry: SavedAnswer = { id: crypto.randomUUID(), question: m.question ?? "", text: m.text, savedAt: new Date().toISOString(), mode: m.ai ? "AI answer" : "Extractive preview" };
      if (mode === "live") {
        const res = await fetch("/api/saved-answers", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ question: entry.question || "(no question)", answer: entry.text, mode: entry.mode, citations: m.citations ?? [] }),
        });
        const data = (await res.json().catch(() => null)) as { saved?: { id: string } } | null;
        if (!res.ok || !data?.saved) return toast("Could not save the answer.");
        entry.id = data.saved.id;
      }
      setSaved((s) => [entry, ...s]);
      toast(mode === "live" ? "Answer saved." : "Answer saved for this tab.");
    },
    [saved, mode, toast],
  );

  const deleteSaved = useCallback(
    async (id: string) => {
      if (mode === "live") {
        const res = await fetch(`/api/saved-answers?id=${encodeURIComponent(id)}`, { method: "DELETE" });
        if (!res.ok) return toast("Could not remove the saved answer.");
      }
      setSaved((s) => s.filter((a) => a.id !== id));
      toast("Saved answer removed.");
    },
    [mode, toast],
  );

  const addNote = useCallback(
    async (title: string, content: string, tags: string[]) => {
      if (looksSensitiveClient(`${title} ${content}`)) {
        toast("Possible credential or private access link detected. Do not add secrets to Jeff.");
        return false;
      }
      const note: JeffDoc = {
        id: "note-" + crypto.randomUUID(),
        source: "notes",
        title,
        content,
        tags: tags.length ? tags : ["ideas"],
        author: "You / Personal notes",
        updated: new Date().toISOString(),
        sample: false,
        url: "",
      };
      if (mode === "live") {
        const res = await fetch("/api/notes", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title, content, tags }) });
        const data = (await res.json().catch(() => null)) as { note?: { id: string } } | null;
        if (!res.ok || !data?.note) {
          toast("Could not save the note.");
          return false;
        }
        note.id = data.note.id;
      } else {
        setSources((s) => new Set(s).add("notes"));
      }
      setNotes((n) => [note, ...n]);
      setFocusSource("notes");
      toast(mode === "live" ? "Note added to your brain." : "A new thought. A new connection. Your note is in your brain for this tab session.");
      return true;
    },
    [mode, toast],
  );

  const deleteNote = useCallback(
    async (id: string) => {
      if (mode === "live") {
        const res = await fetch(`/api/notes?id=${encodeURIComponent(id)}`, { method: "DELETE" });
        if (!res.ok) return toast("Could not remove the note.");
      }
      setNotes((n) => {
        const next = n.filter((x) => x.id !== id);
        if (!next.length) {
          setSources((s) => {
            const c = new Set(s);
            c.delete("notes");
            return c;
          });
          setFocusSource((f) => (f === "notes" ? null : f));
          setChatScope((c) => (c === "notes" ? "all" : c));
        }
        return next;
      });
      toast("Note removed.");
    },
    [mode, toast],
  );

  const refreshConnections = useCallback(async () => {
    // One retry: the list can fail transiently right after a write.
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await fetch("/api/connections", { cache: "no-store" }).catch(() => null);
      if (res?.ok) {
        const data = (await res.json()) as { connections: ConnectionSummary[] };
        setConnections(data.connections);
        return;
      }
      await new Promise((r) => setTimeout(r, 800));
    }
  }, []);

  const setMode = useCallback(
    async (m: Mode) => {
      const res = await fetch("/api/mode", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode: m }) });
      if (!res.ok) return toast("Could not switch mode.");
      setModeState(m);
      setMessages([]);
      setFocusSource(null);
      router.refresh();
      toast(m === "live" ? "Live workspace. Sample data hidden." : "Demo workspace. Sample data only.");
    },
    [router, toast],
  );

  const value: JeffStore = {
    ...initial,
    mode,
    connections,
    notes,
    saved,
    sources,
    focusSource,
    chatScope,
    motion,
    labels,
    busy,
    messages,
    agentOpen,
    sidebarOpen,
    modal,
    toasts,
    connectedSources,
    docs,
    toggleSource,
    setFocusSource,
    setChatScope,
    setMotion,
    setAgentOpen,
    setSidebarOpen,
    openModal,
    closeModal,
    toast,
    ask,
    newChat,
    saveAnswer,
    deleteSaved,
    addNote,
    deleteNote,
    setMode,
    refreshConnections,
    navigate,
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
