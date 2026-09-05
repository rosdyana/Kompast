import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Button } from "@kompast/ui/Button";
import { listThreadsFn, listMessagesFn } from "@/lib/server-fns/ask";
import { streamAskKompast, type AskCitation } from "@/lib/ask-stream-client";

export const Route = createFileRoute("/_app/ask")({
  loader: () => listThreadsFn(),
  component: AskPage,
});

type Thread = Awaited<ReturnType<typeof listThreadsFn>>[number];
type Message = Awaited<ReturnType<typeof listMessagesFn>>[number];
/** Only the streaming-in-progress assistant message is ever client-only (no id yet) — every other message on screen came from listMessagesFn. */
type DisplayMessage = Pick<Message, "role" | "content"> & { id: string; citations?: AskCitation[] };

function AskPage() {
  const initialThreads = Route.useLoaderData();
  const [threads, setThreads] = useState(initialThreads);
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!selectedThreadId) {
      setMessages([]);
      return;
    }
    listMessagesFn({ data: selectedThreadId }).then((rows) => setMessages(rows.map((m) => ({ id: m.id, role: m.role, content: m.content, citations: (m.citations as AskCitation[] | null) ?? undefined }))));
  }, [selectedThreadId]);

  async function refreshThreads() {
    setThreads(await listThreadsFn());
  }

  async function ask() {
    const q = question.trim();
    if (!q || busy) return;
    setQuestion("");
    setError(null);
    setBusy(true);

    const userMsg: DisplayMessage = { id: `local-${Date.now()}`, role: "user", content: q };
    const assistantMsg: DisplayMessage = { id: `local-${Date.now()}-a`, role: "assistant", content: "" };
    setMessages((prev) => [...prev, userMsg, assistantMsg]);

    try {
      const result = await streamAskKompast({ threadId: selectedThreadId ?? undefined, question: q }, (delta) => {
        setMessages((prev) => prev.map((m) => (m.id === assistantMsg.id ? { ...m, content: m.content + delta } : m)));
      });
      setMessages((prev) => prev.map((m) => (m.id === assistantMsg.id ? { ...m, citations: result.citations } : m)));
      if (!selectedThreadId) setSelectedThreadId(result.threadId);
      await refreshThreads();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Ask Kompast gagal");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex h-[calc(100vh-0px)]">
      <div className="w-[220px] flex-none border-r border-border p-3">
        <Button
          variant="outline"
          className="mb-3 w-full text-[12.5px]"
          onClick={() => {
            setSelectedThreadId(null);
            setMessages([]);
          }}
        >
          + Percakapan baru
        </Button>
        <div className="flex flex-col gap-1">
          {threads.map((t) => (
            <button
              key={t.id}
              onClick={() => setSelectedThreadId(t.id)}
              className={`truncate rounded-lg px-2.5 py-1.5 text-left text-[12.5px] hover:bg-surface-2 ${selectedThreadId === t.id ? "bg-surface-2 font-medium" : "text-text-2"}`}
            >
              {t.title || "Percakapan baru"}
            </button>
          ))}
          {threads.length === 0 && <p className="px-2.5 text-[12px] text-text-3">Belum ada percakapan.</p>}
        </div>
      </div>

      <div className="flex flex-1 flex-col">
        <div className="flex-1 overflow-y-auto px-8 py-6">
          {messages.length === 0 && (
            <div className="mx-auto max-w-[560px] pt-16 text-center">
              <h1 className="mb-2 text-xl font-semibold tracking-tight">Tanya Kompast</h1>
              <p className="text-sm text-text-2">Tanyakan sesuatu tentang tiket dan komentar di workspace ini.</p>
            </div>
          )}
          <div className="mx-auto flex max-w-[720px] flex-col gap-4">
            {messages.map((m) => (
              <div key={m.id} className={m.role === "user" ? "self-end" : "self-start"}>
                <div className={`max-w-[560px] rounded-xl px-3.5 py-2.5 text-[13.5px] leading-relaxed ${m.role === "user" ? "bg-accent text-white" : "border border-border bg-surface"}`}>
                  <p className="whitespace-pre-wrap">{m.content || "…"}</p>
                </div>
                {m.citations && m.citations.length > 0 && (
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    {m.citations.map((c, i) => (
                      <span key={i} className="rounded-full bg-surface-2 px-2 py-0.5 text-[10.5px] text-text-3">
                        {c.entityType} · {c.entityId.slice(0, 12)}…
                      </span>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
          {error && <p className="mx-auto mt-3 max-w-[720px] text-[12.5px] text-red-500">{error}</p>}
        </div>

        <div className="border-t border-border p-4">
          <div className="mx-auto flex max-w-[720px] gap-2">
            <input
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && ask()}
              placeholder="Tanyakan sesuatu…"
              className="min-w-0 flex-1 rounded-lg border border-border bg-surface px-3 py-2.5 text-[13.5px] outline-none focus:border-border-2"
            />
            <Button variant="primary" onClick={ask} disabled={busy || !question.trim()}>
              {busy ? "Mengirim…" : "Kirim"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
