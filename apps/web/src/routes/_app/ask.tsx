import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowUp, FileText, MessageSquare, PanelLeftClose, PanelLeftOpen, Plus, Sparkles, Square, Ticket } from "lucide-react";
import { Button, IconButton } from "@kompast/ui/Button";
import { useTranslation } from "@kompast/i18n";
import { listThreadsFn, listMessagesFn } from "@/lib/server-fns/ask";
import { streamAskKompast, type AskCitation } from "@/lib/ask-stream-client";
import { cn } from "@/lib/cn";
import { usePageChrome } from "@/components/shell/WorkbenchContext";

export const Route = createFileRoute("/_app/ask")({
  loader: () => listThreadsFn(),
  component: AskPage,
});

type Message = Awaited<ReturnType<typeof listMessagesFn>>[number];
/** Only the streaming-in-progress assistant message is ever client-only (no id yet) — every other message on screen came from listMessagesFn. */
type DisplayMessage = Pick<Message, "role" | "content"> & { id: string; citations?: AskCitation[] };

function CitationChip({ c }: { c: AskCitation }) {
  const { t } = useTranslation("ask");
  const Icon = c.entityType === "page" ? FileText : c.entityType === "comment" ? MessageSquare : Ticket;
  const label = c.entityType === "page" ? t("sourcePage") : c.entityType === "comment" ? t("sourceComment") : t("sourceIssue");
  return (
    <span
      title={c.excerpt}
      className="inline-flex h-6 max-w-[260px] items-center gap-1.5 rounded-full border border-border bg-surface px-2 text-[12px] text-text-2"
    >
      <Icon size={12} className="flex-none text-text-3" />
      <span className="flex-none font-medium">{label}</span>
      <span className="truncate text-text-3">{c.excerpt}</span>
    </span>
  );
}

function AskPage() {
  const { t } = useTranslation("ask");
  const initialThreads = Route.useLoaderData();
  const [threads, setThreads] = useState(initialThreads);
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [threadListOpen, setThreadListOpen] = useState(true);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // Skip the refetch when a brand-new thread id arrives from our own stream — the messages are already on screen.
  const skipLoadFor = useRef<string | null>(null);

  usePageChrome({ crumbs: [{ label: t("askHeading"), icon: <Sparkles size={15} strokeWidth={1.75} className="text-text-3" /> }] }, [t]);

  useEffect(() => {
    if (typeof window !== "undefined" && window.matchMedia("(max-width: 767px)").matches) setThreadListOpen(false);
  }, []);

  useEffect(() => {
    if (!selectedThreadId) {
      setMessages([]);
      return;
    }
    if (skipLoadFor.current === selectedThreadId) {
      skipLoadFor.current = null;
      return;
    }
    let cancelled = false;
    listMessagesFn({ data: selectedThreadId }).then((rows) => {
      if (!cancelled)
        setMessages(rows.map((m) => ({ id: m.id, role: m.role, content: m.content, citations: (m.citations as AskCitation[] | null) ?? undefined })));
    });
    return () => {
      cancelled = true;
    };
  }, [selectedThreadId]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages]);

  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [question]);

  async function refreshThreads() {
    setThreads(await listThreadsFn());
  }

  function newChat() {
    abortRef.current?.abort();
    setSelectedThreadId(null);
    setMessages([]);
    setError(null);
    inputRef.current?.focus();
  }

  async function ask(text?: string) {
    const q = (text ?? question).trim();
    if (!q || busy) return;
    setQuestion("");
    setError(null);
    setBusy(true);

    const stamp = Date.now();
    const userMsg: DisplayMessage = { id: `local-${stamp}`, role: "user", content: q };
    const assistantMsg: DisplayMessage = { id: `local-${stamp}-a`, role: "assistant", content: "" };
    setMessages((prev) => [...prev, userMsg, assistantMsg]);
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const result = await streamAskKompast(
        { threadId: selectedThreadId ?? undefined, question: q },
        (delta) => setMessages((prev) => prev.map((m) => (m.id === assistantMsg.id ? { ...m, content: m.content + delta } : m))),
        controller.signal,
      );
      setMessages((prev) => prev.map((m) => (m.id === assistantMsg.id ? { ...m, citations: result.citations } : m)));
      if (!selectedThreadId) {
        skipLoadFor.current = result.threadId;
        setSelectedThreadId(result.threadId);
      }
      await refreshThreads();
    } catch (err) {
      if (controller.signal.aborted) {
        setMessages((prev) => prev.map((m) => (m.id === assistantMsg.id ? { ...m, content: m.content || t("stopped") } : m)));
      } else {
        setMessages((prev) => prev.filter((m) => m.id !== assistantMsg.id || m.content));
        setError(err instanceof Error ? err.message : t("askFailed"));
      }
    } finally {
      abortRef.current = null;
      setBusy(false);
    }
  }

  const suggestions = [t("suggestion1"), t("suggestion2"), t("suggestion3")];

  return (
    <div className="flex h-full min-h-0">
      {threadListOpen && (
        <aside className="fixed inset-y-11 left-0 z-30 flex w-[260px] flex-none flex-col border-r border-border bg-surface-2 md:static md:inset-auto md:w-[240px]">
          <div className="flex items-center gap-1 p-2">
            <Button variant="outline" size="sm" className="flex-1 justify-start" onClick={newChat}>
              <Plus size={14} />
              {t("newChat")}
            </Button>
            <IconButton aria-label={t("hideConversationsTitle")} title={t("hideConversationsTitle")} onClick={() => setThreadListOpen(false)}>
              <PanelLeftClose size={16} strokeWidth={1.75} />
            </IconButton>
          </div>
          <p className="px-4 pb-1 pt-2 text-[12px] font-semibold text-text-3">{t("chats")}</p>
          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
            {threads.length === 0 && <p className="px-2 py-1 text-[13px] text-text-3">{t("noConversationsYet")}</p>}
            {threads.map((th) => (
              <button
                key={th.id}
                onClick={() => {
                  setSelectedThreadId(th.id);
                  if (window.matchMedia("(max-width: 767px)").matches) setThreadListOpen(false);
                }}
                className={cn(
                  "flex h-8 w-full items-center truncate rounded-[6px] px-2 text-left text-[13.5px] hover:bg-surface-3",
                  selectedThreadId === th.id ? "bg-surface-4 font-medium text-text" : "text-text-2",
                )}
              >
                <span className="truncate">{th.title || t("untitledThread")}</span>
              </button>
            ))}
          </div>
        </aside>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        {!threadListOpen && (
          <div className="flex-none px-3 pt-2">
            <IconButton aria-label={t("showConversationsTitle")} title={t("showConversationsTitle")} onClick={() => setThreadListOpen(true)}>
              <PanelLeftOpen size={16} strokeWidth={1.75} />
            </IconButton>
          </div>
        )}
        <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-4 sm:px-8">
          {messages.length === 0 ? (
            <div className="mx-auto flex max-w-[720px] flex-col items-center pb-10 pt-[12vh] text-center">
              <span className="mb-4 grid h-11 w-11 place-items-center rounded-[12px] bg-accent-soft text-accent-text">
                <Sparkles size={20} />
              </span>
              <h1 className="type-title">{t("emptyHeading")}</h1>
              <p className="mt-1.5 max-w-[460px] type-body text-text-2">{t("emptySubtitle")}</p>
              <div className="mt-6 flex w-full max-w-[520px] flex-col gap-2">
                {suggestions.map((s) => (
                  <button
                    key={s}
                    onClick={() => ask(s)}
                    className="rounded-[8px] border border-border bg-surface px-3.5 py-2.5 text-left text-[14px] text-text-2 transition-colors hover:border-border-2 hover:bg-surface-2 hover:text-text"
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="mx-auto flex max-w-[720px] flex-col gap-6 py-8">
              {messages.map((m) =>
                m.role === "user" ? (
                  <div key={m.id} className="flex justify-end">
                    <p className="max-w-[85%] whitespace-pre-wrap rounded-[14px] rounded-br-[4px] bg-surface-3 px-4 py-2.5 text-[14.5px] leading-relaxed text-text">
                      {m.content}
                    </p>
                  </div>
                ) : (
                  <div key={m.id} className="flex gap-3">
                    <span className="mt-0.5 grid h-7 w-7 flex-none place-items-center rounded-full bg-accent-soft text-accent-text">
                      <Sparkles size={14} />
                    </span>
                    <div className="min-w-0 flex-1">
                      {m.content ? (
                        <p className="whitespace-pre-wrap text-[15px] leading-[1.7] text-text">{m.content}</p>
                      ) : (
                        <p className="flex items-center gap-2 text-[14px] text-text-3">
                          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-text-3" />
                          {t("thinking")}
                        </p>
                      )}
                      {m.citations && m.citations.length > 0 && (
                        <div className="mt-3">
                          <p className="mb-1.5 text-[12px] font-medium text-text-3">{t("sources")}</p>
                          <div className="flex flex-wrap gap-1.5">
                            {m.citations.map((c, i) => (
                              <CitationChip key={i} c={c} />
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                ),
              )}
            </div>
          )}
        </div>

        <div className="flex-none bg-bg px-4 pb-4 pt-2 sm:px-8">
          <div className="mx-auto max-w-[720px]">
            {error && <p className="mb-2 rounded-[6px] bg-danger-soft px-3 py-2 text-[13px] text-danger">{error}</p>}
            <div className="flex items-end gap-2 rounded-[12px] border border-border-2 bg-surface p-2 shadow-card transition-[border-color,box-shadow] focus-within:border-accent focus-within:shadow-[0_0_0_3px_var(--accent-soft)]">
              <textarea
                ref={inputRef}
                rows={1}
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    ask();
                  }
                }}
                placeholder={t("inputPlaceholder")}
                aria-label={t("inputPlaceholder")}
                className="max-h-[200px] min-h-[36px] min-w-0 flex-1 resize-none bg-transparent px-2 py-1.5 text-[15px] leading-6 outline-none"
              />
              {busy ? (
                <Button variant="secondary" icon aria-label={t("stop")} title={t("stop")} onClick={() => abortRef.current?.abort()}>
                  <Square size={13} fill="currentColor" />
                </Button>
              ) : (
                <Button variant="primary" icon aria-label={t("send")} title={t("send")} onClick={() => ask()} disabled={!question.trim()}>
                  <ArrowUp size={16} strokeWidth={2.25} />
                </Button>
              )}
            </div>
            <p className="mt-1.5 hidden text-center text-[12px] text-text-3 sm:block">{t("composerHint")}</p>
          </div>
        </div>
      </div>
    </div>
  );
}
