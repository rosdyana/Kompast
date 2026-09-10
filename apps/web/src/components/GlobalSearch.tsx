import { useEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { SearchField } from "@kompast/ui/Input";
import { useTranslation } from "@kompast/i18n";
import { searchWorkspaceFn } from "@/lib/server-fns/search";

type SearchResult = Awaited<ReturnType<typeof searchWorkspaceFn>>;

export function GlobalSearch() {
  const { t } = useTranslation("search");
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
        placeholder={t("placeholder")}
        className="w-[210px]"
        value={query}
        onChange={(e) => handleChange(e.target.value)}
        onFocus={() => hasResults && setOpen(true)}
        onKeyDown={(e) => e.key === "Escape" && setOpen(false)}
      />
      {open && (
        <div className="absolute right-0 top-[calc(100%+6px)] z-20 max-h-[360px] w-[320px] overflow-y-auto rounded-[9px] border border-border bg-surface shadow-kp">
          {loading && <p className="px-3 py-3 type-body text-text-3">{t("searching")}</p>}
          {!loading && !hasResults && <p className="px-3 py-3 type-body text-text-3">{t("noResults")}</p>}
          {!loading && result && result.issues.length > 0 && (
            <div className="border-b border-border py-1.5">
              <p className="px-3 pb-1 type-label-overline text-text-3">{t("issuesHeading")}</p>
              {result.issues.map((issue) => (
                <Link
                  key={issue.id}
                  to="/issues/$teamId/$projectKey/$issueKeySeq"
                  params={{ teamId: issue.teamId ?? "none", projectKey: issue.projectKey, issueKeySeq: String(issue.keySeq) }}
                  onClick={() => setOpen(false)}
                  className="flex items-center gap-2 px-3 py-1.5 type-body hover:bg-surface-2"
                >
                  <span className="type-label text-text-3">
                    {issue.projectKey}-{issue.keySeq}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{issue.title}</span>
                  {issue.teamName && <span className="flex-none text-[10.5px] text-text-3">{issue.teamName}</span>}
                  <span className="flex-none text-[10.5px] text-text-3">{issue.statusName}</span>
                </Link>
              ))}
            </div>
          )}
          {!loading && result && result.people.length > 0 && (
            <div className="py-1.5">
              <p className="px-3 pb-1 type-label-overline text-text-3">{t("peopleHeading")}</p>
              {result.people.map((person) => (
                <div key={person.id} className="flex items-center gap-2 px-3 py-1.5 type-body">
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
