import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowUp, ExternalLink, FileText, MessageSquare, MoreHorizontal, PanelLeftClose, PanelLeftOpen, Pencil, Plus, Sparkles, Square, Ticket, Trash2 } from "lucide-react";
import { Button, IconButton } from "@kompast/ui/Button";
import { Popover } from "@kompast/ui/Popover";
import { MenuItem, MenuList } from "@kompast/ui/Menu";
import { useTranslation } from "@kompast/i18n";
import type { AskProposal } from "@kompast/core";
import { listThreadsFn, listMessagesFn, applyAskProposalFn, discardAskProposalFn, renameThreadFn, deleteThreadFn } from "@/lib/server-fns/ask";
import { streamAskKompast, type AskCitation } from "@/lib/ask-stream-client";
import { cn } from "@/lib/cn";
import { usePageChrome } from "@/components/shell/WorkbenchContext";
import { Markdown } from "@/components/shared/Markdown";
import { SourcePanel } from "@/components/ask/SourcePanel";
import { ConfirmDialog } from "@/components/settings/ConfirmDialog";

export const Route = createFileRoute("/_app/ask")({
  loader: () => listThreadsFn(),
  component: AskPage,
});

type Message = Awaited<ReturnType<typeof listMessagesFn>>[number];
type Thread = Awaited<ReturnType<typeof listThreadsFn>>[number];
/**
 * Only the streaming-in-progress assistant message is ever client-only (no id yet) — every other message on screen came from listMessagesFn.
 * `messageId` is the saved assistant message that owns `proposals`; Apply/Discard need it, so they stay off until the answer is saved.
 */
type DisplayMessage = Pick<Message, "role" | "content"> & { id: string; citations?: AskCitation[]; proposals?: AskProposal[]; messageId?: string };

/** Which status line to show for a running lookup. An unrecognized tool name falls back to a generic line rather than rendering nothing. */
const TOOL_STATUS_KEYS = {
  list_projects: "toolListProjects",
  list_issues: "toolListIssues",
  get_issue: "toolGetIssue",
  get_sprint: "toolGetSprint",
  search_workspace: "toolSearchWorkspace",
  create_issue: "toolCreateIssue",
  add_comment: "toolAddComment",
  create_page: "toolCreatePage",
} as const;

const PROPOSAL_KIND_KEYS = {
  create_issue: "proposalKindIssue",
  add_comment: "proposalKindComment",
  create_page: "proposalKindPage",
} as const;

const PROPOSAL_KIND_ICONS = {
  create_issue: Ticket,
  add_comment: MessageSquare,
  create_page: FileText,
} as const;

const CHIP_CLASS = "inline-flex h-6 max-w-[260px] items-center gap-1.5 rounded-full border border-border bg-surface px-2 text-[12px] text-text-2";
const CHIP_LINK_CLASS = `${CHIP_CLASS} transition-colors hover:border-border-2 hover:bg-surface-2 hover:text-text`;
const CHIP_ACTIVE_CLASS = "border-accent bg-accent-soft text-text";

/**
 * A cited source. With a ref, the chip opens the preview panel in place; a small trailing icon still navigates to the full page.
 * Legacy citations without a ref stay inert.
 */
function CitationChip({ c, active, onOpen }: { c: AskCitation; active: boolean; onOpen: (c: AskCitation) => void }) {
  const { t } = useTranslation("ask");
  const Icon = c.entityType === "page" ? FileText : c.entityType === "comment" ? MessageSquare : Ticket;
  const label = c.entityType === "page" ? t("sourcePage") : c.entityType === "comment" ? t("sourceComment") : t("sourceIssue");
  const body = (
    <>
      <Icon size={12} className="flex-none text-text-3" />
      <span className="flex-none font-medium">{label}</span>
      <span className="truncate text-text-3">{c.title || c.excerpt}</span>
    </>
  );

  if (!c.ref) {
    return (
      <span title={c.excerpt} className={CHIP_CLASS}>
        {body}
      </span>
    );
  }

  const fullLink =
    c.ref.kind === "issue" ? (
      <Link
        to="/issues/$teamId/$projectKey/$issueKeySeq"
        params={{ teamId: c.ref.teamId ?? "none", projectKey: c.ref.projectKey, issueKeySeq: String(c.ref.keySeq) }}
        title={t("openSource")}
        aria-label={t("openSource")}
        className="grid h-6 w-6 flex-none place-items-center rounded-full text-text-3 transition-colors hover:bg-surface-3 hover:text-text"
      >
        <ExternalLink size={12} />
      </Link>
    ) : (
      <Link
        to="/docs/$pageId"
        params={{ pageId: c.ref.pageId }}
        title={t("openSource")}
        aria-label={t("openSource")}
        className="grid h-6 w-6 flex-none place-items-center rounded-full text-text-3 transition-colors hover:bg-surface-3 hover:text-text"
      >
        <ExternalLink size={12} />
      </Link>
    );

  return (
    <span className="inline-flex max-w-full items-center gap-0.5">
      <button
        type="button"
        onClick={() => onOpen(c)}
        aria-pressed={active}
        title={c.excerpt}
        className={cn(CHIP_LINK_CLASS, "min-w-0", active && CHIP_ACTIVE_CLASS)}
      >
        {body}
      </button>
      {fullLink}
    </span>
  );
}

/**
 * One conversation in the left list. The select button and the menu button are siblings (never a button inside a button).
 * Rename swaps the title for an inline input; the parent performs the server call, so this row only owns its own edit state.
 */
function ThreadRow({
  thread,
  selected,
  onSelect,
  onRename,
  onRequestDelete,
}: {
  thread: Thread;
  selected: boolean;
  onSelect: () => void;
  onRename: (title: string) => void;
  onRequestDelete: () => void;
}) {
  const { t } = useTranslation("ask");
  const [menuOpen, setMenuOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const menuRef = useRef<HTMLButtonElement>(null);
  /** Enter, Escape and the blur that follows the input unmounting must settle the edit exactly once. */
  const settledRef = useRef(false);
  const currentTitle = thread.title ?? "";

  function startRename() {
    setMenuOpen(false);
    settledRef.current = false;
    setDraft(currentTitle);
    setEditing(true);
  }

  function settle(save: boolean) {
    if (settledRef.current) return;
    settledRef.current = true;
    setEditing(false);
    const next = draft.trim();
    if (save && next && next !== currentTitle) onRename(next);
  }

  return (
    <div
      className={cn(
        "group flex h-8 items-center rounded-[6px] hover:bg-surface-3 focus-within:bg-surface-3",
        selected ? "bg-surface-4" : "",
      )}
    >
      {editing ? (
        <input
          autoFocus
          value={draft}
          aria-label={t("renameChat")}
          onChange={(e) => setDraft(e.target.value)}
          onFocus={(e) => e.currentTarget.select()}
          onBlur={() => settle(true)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing) {
              e.preventDefault();
              settle(true);
            } else if (e.key === "Escape") {
              // Keeps the Ask preview's window-level Escape handler from also firing.
              e.preventDefault();
              e.stopPropagation();
              settle(false);
            }
          }}
          className="mx-1 h-7 min-w-0 flex-1 rounded-[5px] border border-border-2 bg-surface px-2 text-[13.5px] text-text outline-none focus:border-accent"
        />
      ) : (
        <button
          type="button"
          onClick={onSelect}
          aria-current={selected ? "true" : undefined}
          className={cn(
            "flex h-8 min-w-0 flex-1 items-center truncate rounded-[6px] px-2 text-left text-[13.5px]",
            selected ? "font-medium text-text" : "text-text-2",
          )}
        >
          <span className="truncate">{thread.title || t("untitledThread")}</span>
        </button>
      )}
      {!editing && (
        <IconButton
          ref={menuRef}
          size="sm"
          aria-label={t("chatActions")}
          title={t("chatActions")}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((v) => !v)}
          className={cn(
            "mr-0.5 flex-none opacity-100 transition-opacity md:opacity-0 md:group-focus-within:opacity-100 md:group-hover:opacity-100",
            menuOpen && "opacity-100 md:opacity-100",
          )}
        >
          <MoreHorizontal size={14} />
        </IconButton>
      )}
      <Popover open={menuOpen} onClose={() => setMenuOpen(false)} anchorRef={menuRef} placement="bottom-end" role="menu">
        <MenuList>
          <MenuItem icon={<Pencil size={14} />} onClick={startRename}>
            {t("renameChat")}
          </MenuItem>
          <MenuItem
            danger
            icon={<Trash2 size={14} />}
            onClick={() => {
              setMenuOpen(false);
              onRequestDelete();
            }}
          >
            {t("deleteChat")}
          </MenuItem>
        </MenuList>
      </Popover>
    </div>
  );
}

/**
 * A drafted change under an assistant answer. Shows the preview as plain text (the full body is revealed on demand, never as HTML).
 * Apply/Discard appear only when the proposal is pending and the answer is saved; the parent performs the server call and
 * updates the proposal's status, and a failure is shown inline on the card.
 */
function ProposalCard({
  proposal,
  canAct,
  onApply,
  onDiscard,
}: {
  proposal: AskProposal;
  canAct: boolean;
  onApply: (proposal: AskProposal) => Promise<void>;
  onDiscard: (proposal: AskProposal) => Promise<void>;
}) {
  const { t } = useTranslation("ask");
  const [showFull, setShowFull] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const Icon = PROPOSAL_KIND_ICONS[proposal.kind];
  const pending = proposal.status === "pending";

  async function run(action: (p: AskProposal) => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action(proposal);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("proposalFailed"));
    } finally {
      setBusy(false);
    }
  }

  const result = proposal.result;
  const openLink =
    proposal.status === "applied" && result ? (
      result.pageId ? (
        <Link to="/docs/$pageId" params={{ pageId: result.pageId }} className="text-[13px] text-accent-text hover:underline">
          {t("proposalOpenPage")}
        </Link>
      ) : result.projectKey && result.keySeq !== undefined ? (
        <Link
          to="/issues/$teamId/$projectKey/$issueKeySeq"
          params={{ teamId: result.teamId ?? "none", projectKey: result.projectKey, issueKeySeq: String(result.keySeq) }}
          className="text-[13px] text-accent-text hover:underline"
        >
          {t("proposalOpenIssue")}
        </Link>
      ) : null
    ) : null;

  return (
    <div className={cn("rounded-[10px] border border-border bg-surface p-3", proposal.status === "discarded" && "opacity-60")}>
      <p className="flex items-center gap-1.5 text-[12px] font-medium text-text-3">
        <Icon size={12} className="flex-none" />
        {t(PROPOSAL_KIND_KEYS[proposal.kind])}
      </p>
      <p className="mt-1.5 text-[14.5px] font-medium text-text">{proposal.preview.title}</p>
      {proposal.preview.lines.length > 0 && (
        <ul className="mt-1 space-y-0.5 text-[13px] text-text-2">
          {proposal.preview.lines.map((line, i) => (
            <li key={i}>{line}</li>
          ))}
        </ul>
      )}
      {proposal.preview.body && (
        <div className="mt-2">
          <button type="button" onClick={() => setShowFull((v) => !v)} className="text-[12.5px] text-accent-text hover:underline">
            {showFull ? t("proposalHideFull") : t("proposalShowFull")}
          </button>
          {showFull && (
            <p className="mt-1.5 max-h-[320px] overflow-y-auto whitespace-pre-wrap rounded-[6px] bg-surface-2 p-2.5 text-[13.5px] leading-relaxed text-text-2">
              {proposal.preview.body}
            </p>
          )}
        </div>
      )}
      {error && <p className="mt-2 rounded-[6px] bg-danger-soft px-2.5 py-1.5 text-[12.5px] text-danger">{error}</p>}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {pending && canAct && (
          <>
            <Button variant="primary" size="sm" onClick={() => run(onApply)} disabled={busy}>
              {t("proposalApply")}
            </Button>
            <Button variant="outline" size="sm" onClick={() => run(onDiscard)} disabled={busy}>
              {t("proposalDiscard")}
            </Button>
          </>
        )}
        {pending && !canAct && <p className="text-[12.5px] text-text-3">{t("proposalDraftNote")}</p>}
        {proposal.status === "applied" && <span className="text-[13px] font-medium text-accent-text">{t("proposalApplied")}</span>}
        {proposal.status === "discarded" && <span className="text-[13px] text-text-3">{t("proposalDiscarded")}</span>}
        {openLink}
      </div>
    </div>
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
  /** The tool the model is running right now, shown as a transient status line. Cleared when text starts arriving or the answer ends. */
  const [toolName, setToolName] = useState<string | null>(null);
  const [threadListOpen, setThreadListOpen] = useState(true);
  /** The cited source shown in the right-hand panel. Cleared on new chat, on switching thread, and when the open thread is deleted. */
  const [preview, setPreview] = useState<AskCitation | null>(null);
  /** The thread id awaiting delete confirmation. */
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
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
        setMessages(
          rows.map((m) => ({
            id: m.id,
            messageId: m.role === "assistant" ? m.id : undefined,
            role: m.role,
            content: m.content,
            citations: (m.citations as AskCitation[] | null) ?? undefined,
            proposals: (m.proposals as AskProposal[] | null) ?? undefined,
          })),
        );
    });
    return () => {
      cancelled = true;
    };
  }, [selectedThreadId]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages]);

  useEffect(() => {
    if (!preview) return;
    function onKey(e: KeyboardEvent) {
      // Escape already handled by an open menu (capture phase, stops propagation) or the rename input; the delete dialog
      // closes on its own Escape without stopping propagation, so skip while it is open.
      if (e.key === "Escape" && !e.defaultPrevented && deleteTarget === null) setPreview(null);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [preview, deleteTarget]);

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
    setPreview(null);
    inputRef.current?.focus();
  }

  /** Optimistic: the list shows the new title at once; a failed save puts the previous title back and shows the error. */
  async function renameChat(threadId: string, title: string) {
    const previous = threads.find((th) => th.id === threadId)?.title ?? null;
    setThreads((prev) => prev.map((th) => (th.id === threadId ? { ...th, title } : th)));
    try {
      await renameThreadFn({ data: { threadId, title } });
    } catch (err) {
      setThreads((prev) => prev.map((th) => (th.id === threadId ? { ...th, title: previous } : th)));
      setError(err instanceof Error ? err.message : t("renameFailed"));
    }
  }

  /** Errors propagate so ConfirmDialog shows them inline and stays open. */
  async function deleteChat(threadId: string) {
    await deleteThreadFn({ data: threadId });
    setThreads((prev) => prev.filter((th) => th.id !== threadId));
    if (selectedThreadId === threadId) newChat();
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
        (delta) => {
          setToolName(null);
          setMessages((prev) => prev.map((m) => (m.id === assistantMsg.id ? { ...m, content: m.content + delta } : m)));
        },
        controller.signal,
        (name) => setToolName(name),
        (proposal) =>
          setMessages((prev) => prev.map((m) => (m.id === assistantMsg.id ? { ...m, proposals: [...(m.proposals ?? []), proposal] } : m))),
      );
      setMessages((prev) =>
        prev.map((m) => (m.id === assistantMsg.id ? { ...m, citations: result.citations, messageId: result.messageId } : m)),
      );
      if (!selectedThreadId) {
        skipLoadFor.current = result.threadId;
        setSelectedThreadId(result.threadId);
      }
      await refreshThreads();
    } catch (err) {
      // A stream that never saved its answer leaves no messageId, so any cards it streamed could never be applied: drop them.
      if (controller.signal.aborted) {
        setMessages((prev) => prev.map((m) => (m.id === assistantMsg.id ? { ...m, content: m.content || t("stopped"), proposals: undefined } : m)));
      } else {
        setMessages((prev) => prev.map((m) => (m.id === assistantMsg.id ? { ...m, proposals: undefined } : m)).filter((m) => m.id !== assistantMsg.id || m.content));
        setError(err instanceof Error ? err.message : t("askFailed"));
      }
    } finally {
      abortRef.current = null;
      setToolName(null);
      setBusy(false);
    }
  }

  /** Swaps one proposal on one message for its server-returned state (applied or discarded). */
  function replaceProposal(messageKey: string, next: AskProposal) {
    setMessages((prev) =>
      prev.map((m) => (m.id === messageKey ? { ...m, proposals: m.proposals?.map((p) => (p.id === next.id ? next : p)) } : m)),
    );
  }

  async function applyProposal(message: DisplayMessage, proposal: AskProposal) {
    if (!message.messageId) return;
    const next = await applyAskProposalFn({ data: { messageId: message.messageId, proposalId: proposal.id } });
    replaceProposal(message.id, next);
  }

  async function discardProposal(message: DisplayMessage, proposal: AskProposal) {
    if (!message.messageId) return;
    const next = await discardAskProposalFn({ data: { messageId: message.messageId, proposalId: proposal.id } });
    replaceProposal(message.id, next);
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
              <ThreadRow
                key={th.id}
                thread={th}
                selected={selectedThreadId === th.id}
                onSelect={() => {
                  setSelectedThreadId(th.id);
                  setPreview(null);
                  if (window.matchMedia("(max-width: 767px)").matches) setThreadListOpen(false);
                }}
                onRename={(title) => renameChat(th.id, title)}
                onRequestDelete={() => setDeleteTarget(th.id)}
              />
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
                        <Markdown content={m.content} className="text-[15px] leading-[1.7] text-text" />
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
                              <CitationChip
                                key={i}
                                c={c}
                                active={preview?.entityType === c.entityType && preview?.entityId === c.entityId}
                                onOpen={(next) => setPreview(next)}
                              />
                            ))}
                          </div>
                        </div>
                      )}
                      {m.proposals && m.proposals.length > 0 && (
                        <div className="mt-3 flex flex-col gap-2">
                          {m.proposals.map((p) => (
                            <ProposalCard
                              key={p.id}
                              proposal={p}
                              canAct={!!m.messageId}
                              onApply={(proposal) => applyProposal(m, proposal)}
                              onDiscard={(proposal) => discardProposal(m, proposal)}
                            />
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                ),
              )}
              {toolName && (
                <p className="flex items-center gap-2 pl-10 text-[13px] text-text-3">
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-text-3" />
                  {t(TOOL_STATUS_KEYS[toolName as keyof typeof TOOL_STATUS_KEYS] ?? "toolGeneric")}
                </p>
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

      {preview && <SourcePanel key={`${preview.entityType}:${preview.entityId}`} citation={preview} onClose={() => setPreview(null)} />}

      <ConfirmDialog
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        title={t("deleteChatTitle")}
        body={t("deleteChatBody")}
        confirmLabel={t("deleteChat")}
        cancelLabel={t("cancel")}
        onConfirm={async () => {
          if (deleteTarget) await deleteChat(deleteTarget);
        }}
      />
    </div>
  );
}
