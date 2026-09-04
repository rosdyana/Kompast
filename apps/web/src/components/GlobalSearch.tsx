import { useEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { SearchField } from "@kompast/ui/Input";
import { searchWorkspaceFn } from "@/lib/server-fns/search";

type SearchResult = Awaited<ReturnType<typeof searchWorkspaceFn>>;

export function GlobalSearch() {
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<SearchResult | null>(null);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, []);

  function handleChange(value: string) {
    setQuery(value);
    clearTimeout(debounceRef.current);

    if (value.trim().length < 2) {
      setResult(null);
      setOpen(false);
      return;
    }

    debounceRef.current = setTimeout(async () => {
      setLoading(true);
      try {
        const res = await searchWorkspaceFn({ data: value });
        setResult(res);
        setOpen(true);
      } finally {
        setLoading(false);
      }
    }, 220);
  }

  const hasResults = !!result && (result.issues.length > 0 || result.people.length > 0);

  return (
    <div ref={containerRef} className="relative">
      <SearchField
        placeholder="Cari tiket, orang…"
        className="w-[210px]"
        value={query}
        onChange={(e) => handleChange(e.target.value)}
        onFocus={() => hasResults && setOpen(true)}
        onKeyDown={(e) => e.key === "Escape" && setOpen(false)}
      />
      {open && (
        <div className="absolute right-0 top-[calc(100%+6px)] z-20 max-h-[360px] w-[320px] overflow-y-auto rounded-[9px] border border-border bg-surface shadow-kp">
          {loading && <p className="px-3 py-3 text-[12px] text-text-3">Mencari…</p>}
          {!loading && !hasResults && <p className="px-3 py-3 text-[12px] text-text-3">Tidak ada hasil.</p>}
          {!loading && result && result.issues.length > 0 && (
            <div className="border-b border-border py-1.5">
              <p className="px-3 pb-1 font-mono text-[9.5px] uppercase tracking-[0.1em] text-text-3">Tiket</p>
              {result.issues.map((issue) => (
                <Link
                  key={issue.id}
                  to="/issues/$projectKey/$issueKeySeq"
                  params={{ projectKey: issue.projectKey, issueKeySeq: String(issue.keySeq) }}
                  onClick={() => setOpen(false)}
                  className="flex items-center gap-2 px-3 py-1.5 text-[12.5px] hover:bg-surface-2"
                >
                  <span className="font-mono text-[10.5px] text-text-3">
                    {issue.projectKey}-{issue.keySeq}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{issue.title}</span>
                  <span className="flex-none text-[10.5px] text-text-3">{issue.statusName}</span>
                </Link>
              ))}
            </div>
          )}
          {!loading && result && result.people.length > 0 && (
            <div className="py-1.5">
              <p className="px-3 pb-1 font-mono text-[9.5px] uppercase tracking-[0.1em] text-text-3">Orang</p>
              {result.people.map((person) => (
                <div key={person.id} className="flex items-center gap-2 px-3 py-1.5 text-[12.5px]">
                  <span className="min-w-0 flex-1 truncate">{person.name}</span>
                  <span className="flex-none truncate text-[10.5px] text-text-3">{person.email}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
