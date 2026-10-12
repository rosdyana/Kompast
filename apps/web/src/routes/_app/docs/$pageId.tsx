import { createFileRoute, ClientOnly, Link, useRouter, useLoaderData } from "@tanstack/react-router";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import {
  Building2,
  Check,
  Copy,
  CopyPlus,
  FileText,
  FolderInput,
  Globe,
  History,
  LayoutTemplate,
  Lock,
  Link2,
  MoreHorizontal,
  MoveHorizontal,
  Plus,
  Share2,
  SmilePlus,
  Star,
  Trash2,
  UsersRound,
  X,
} from "lucide-react";
import { Button, IconButton } from "@kompast/ui/Button";
import { Avatar } from "@kompast/ui/Avatar";
import { Badge } from "@kompast/ui/Badge";
import { Popover } from "@kompast/ui/Popover";
import { MenuItem, MenuLabel, MenuList, MenuSeparator } from "@kompast/ui/Menu";
import { NativeSelect } from "@kompast/ui/Input";
import { useToast } from "@kompast/ui/Toast";
import { useTranslation, type SupportedLocale } from "@kompast/i18n";
import {
  getPageDetailFn,
  updatePageMetaFn,
  createPageFn,
  archivePageFn,
  restorePageFn,
  duplicatePageFn,
  toggleFavoritePageFn,
  addPageCommentFn,
  linkPageToIssueFn,
  unlinkPageFromIssueFn,
  createShareLinkFn,
  revokeShareLinkFn,
  setPageTemplateFn,
  getPageAccessFn,
  grantPageAccessFn,
  revokePageAccessFn,
  movePageToSpaceFn,
} from "@/lib/server-fns/pages";
import { resolveIssueByKeyFn } from "@/lib/server-fns/issue-detail";
import { DocEditor, type DocEditorHandle } from "@/components/docs/Editor";
import { VersionHistoryDialog } from "@/components/docs/VersionHistory";
import { PageIcon } from "@/components/docs/DocsTree";
import { relativeTime } from "@/components/docs/relative-time";
import { ProjectIcon } from "@/components/shell/ProjectIcon";
import { usePageChrome, type Crumb } from "@/components/shell/WorkbenchContext";
import { cn } from "@/lib/cn";
import { NoAccessState } from "@/components/shared/NoAccessState";

export const Route = createFileRoute("/_app/docs/$pageId")({
  loader: ({ params }) => getPageDetailFn({ data: params.pageId }),
  component: DocPage,
  notFoundComponent: NoAccessState,
});

type PageData = Awaited<ReturnType<typeof getPageDetailFn>>;

const INTL_LOCALE: Record<SupportedLocale, string> = { en: "en-US", id: "id-ID", "zh-Hant": "zh-Hant-TW" };

const EMOJI = [
  "📄", "📝", "📌", "📎", "📚", "📖", "🗂️", "🗒️", "📋", "📊", "📈", "📉", "🗓️", "⏰", "✅", "☑️",
  "🎯", "🚀", "💡", "🔥", "⭐", "✨", "🏆", "🎉", "🧭", "🗺️", "🧩", "🛠️", "⚙️", "🔧", "🔒", "🔑",
  "🐛", "🧪", "🔬", "💻", "🖥️", "📱", "🌐", "☁️", "🗄️", "🔌", "📦", "🧱", "🏗️", "🏭", "🧾", "💰",
  "💬", "📣", "📢", "✉️", "🤝", "👥", "👤", "🙋", "🧠", "❤️", "💚", "💙", "💜", "🟢", "🟡", "🔴",
  "🌱", "🌳", "🌊", "⛰️", "☀️", "🌙", "⚡", "❄️", "🍀", "🎨", "🎵", "📷", "✈️", "🏠", "🏢", "🚩",
];

function fullWidthKey(pageId: string) {
  return `kompast-doc-fullwidth:${pageId}`;
}

function DocPage() {
  const data = Route.useLoaderData();
  // Keyed by page id: this route component is reused across /docs/A →
  // /docs/B navigations, so without a remount every useState initialized
  // from the loader (title, favorite, template flag, …) would keep page A's
  // value — and blurring the title field would save A's title onto B.
  return <DocPageBody key={data.page.id} data={data} />;
}

function DocPageBody({ data }: { data: PageData }) {
  const { t, i18n } = useTranslation(["docs", "common"]);
  const intlLocale = INTL_LOCALE[i18n.language as SupportedLocale] ?? "en-US";
  const shell = useLoaderData({ from: "/_app" });
  const router = useRouter();
  const toast = useToast();

  const [title, setTitle] = useState(data.page.title);
  const [icon, setIcon] = useState<string | null>(data.page.icon);
  const [favorited, setFavorited] = useState(data.isFavorited);
  const [isTemplate, setIsTemplate] = useState(data.page.type === "template");
  const [fullWidth, setFullWidth] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [editor, setEditor] = useState<DocEditorHandle | null>(null);

  useEffect(() => {
    try {
      setFullWidth(window.localStorage.getItem(fullWidthKey(data.page.id)) === "1");
    } catch {
      /* storage blocked */
    }
  }, [data.page.id]);

  function toggleFullWidth() {
    const next = !fullWidth;
    setFullWidth(next);
    try {
      window.localStorage.setItem(fullWidthKey(data.page.id), next ? "1" : "0");
    } catch {
      /* not persisted */
    }
  }

  async function saveTitle() {
    if (title === data.page.title) return;
    await updatePageMetaFn({ data: { pageId: data.page.id, title } });
    await router.invalidate();
  }

  async function saveIcon(next: string | null) {
    setIcon(next);
    await updatePageMetaFn({ data: { pageId: data.page.id, icon: next } });
    await router.invalidate();
  }

  async function toggleFavorite() {
    const res = await toggleFavoritePageFn({ data: data.page.id });
    setFavorited(res.favorited);
    await router.invalidate();
  }

  async function toggleTemplate() {
    const next = !isTemplate;
    setIsTemplate(next);
    await setPageTemplateFn({ data: { pageId: data.page.id, isTemplate: next } });
    await router.invalidate();
  }

  async function duplicate() {
    const copy = await duplicatePageFn({ data: { pageId: data.page.id, titleSuffix: t("pageDetail.copySuffix") } });
    toast.show({ title: t("pageDetail.duplicated") });
    await router.navigate({ to: "/docs/$pageId", params: { pageId: copy.id } });
    await router.invalidate();
  }

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(window.location.href);
      toast.show({ title: t("pageDetail.linkCopied") });
    } catch {
      toast.show({ tone: "error", title: window.location.href });
    }
  }

  async function moveToSpace(space: SpaceTarget, label: string) {
    try {
      await movePageToSpaceFn({ data: { pageId: data.page.id, ...space } });
      toast.show({ title: t("pageDetail.movedTo", { space: label }) });
      await router.invalidate();
    } catch (err) {
      toast.show({ tone: "error", title: t("common:somethingWentWrong"), description: err instanceof Error ? err.message : undefined });
    }
  }

  async function moveToTrash() {
    const pageId = data.page.id;
    await archivePageFn({ data: pageId });
    await router.navigate({ to: "/docs" });
    await router.invalidate();
    toast.show({
      title: t("pageDetail.movedToTrash"),
      description: data.page.title || t("untitled"),
      action: {
        label: t("pageDetail.undo"),
        onClick: async () => {
          await restorePageFn({ data: pageId });
          await router.navigate({ to: "/docs/$pageId", params: { pageId } });
          await router.invalidate();
        },
      },
    });
  }

  // ── Topbar chrome ────────────────────────────────────────────────────
  const crumbs: Crumb[] = [];
  // The space crumb leads, so where a page lives (and so who can see it) is
  // always visible: a project, a team's own space, Private, or the shared Workspace.
  const spaceTeam = data.page.teamId ? shell.teams.find((tm) => tm.id === data.page.teamId) : undefined;
  if (!data.project) {
    crumbs.push(
      data.page.privateOwnerId && data.page.sharedWith.length > 0
        ? { label: t("nav:sharedDocs"), icon: <Share2 size={15} strokeWidth={1.75} className="text-text-3" /> }
        : data.page.privateOwnerId
        ? { label: t("nav:privateDocs"), icon: <Lock size={15} strokeWidth={1.75} className="text-text-3" /> }
        : spaceTeam
          ? { label: spaceTeam.name, icon: <UsersRound size={15} strokeWidth={1.75} className="text-text-3" /> }
          : { label: t("nav:workspaceDocs"), icon: <Building2 size={15} strokeWidth={1.75} className="text-text-3" /> },
    );
  }
  if (data.project) {
    crumbs.push({
      label: data.project.name,
      icon: <ProjectIcon projectKey={data.project.key} size={16} />,
      link: { to: "/projects/$teamId/$projectKey", params: { teamId: data.project.teamId ?? "none", projectKey: data.project.key }, search: { tab: "docs" } },
    });
  }
  for (const a of data.ancestors) {
    crumbs.push({ label: a.title || t("untitled"), icon: <PageIcon icon={a.icon} size={15} />, link: { to: "/docs/$pageId", params: { pageId: a.id } } });
  }
  crumbs.push({ label: title || t("untitled"), icon: <PageIcon icon={icon} size={15} /> });

  const updatedAt = new Date(data.page.updatedAt);

  usePageChrome(
    {
      crumbs,
      actions: (
        <div className="flex items-center gap-0.5">
          <span className="mr-1.5 hidden text-[13px] text-text-3 lg:inline" title={updatedAt.toLocaleString(intlLocale)}>
            {t("pageDetail.editedAgo", { time: relativeTime(updatedAt, intlLocale) })}
          </span>
          {isTemplate && (
            <Badge tone="violet" className="mr-1">
              {t("pageDetail.templateBadge")}
            </Badge>
          )}
          <SharePopover data={data} />
          <IconButton
            aria-label={favorited ? t("pageDetail.favoriteOn") : t("pageDetail.favoriteOff")}
            title={favorited ? t("pageDetail.favoriteOn") : t("pageDetail.favoriteOff")}
            aria-pressed={favorited}
            onClick={toggleFavorite}
          >
            <Star size={17} strokeWidth={1.75} className={cn(favorited && "fill-amber text-amber")} />
          </IconButton>
          <MoreMenu
            canEdit={data.canEdit}
            isTemplate={isTemplate}
            fullWidth={fullWidth}
            onDuplicate={duplicate}
            onCopyLink={copyLink}
            onToggleTemplate={toggleTemplate}
            onHistory={() => setHistoryOpen(true)}
            onToggleFullWidth={toggleFullWidth}
            onTrash={moveToTrash}
            currentSpace={{ projectId: data.page.projectId, teamId: data.page.teamId, private: !!data.page.privateOwnerId && data.page.sharedWith.length === 0 }}
            onMove={moveToSpace}
          />
        </div>
      ),
    },
    [title, icon, favorited, isTemplate, fullWidth, data, intlLocale],
  );

  return (
    <div className={cn("mx-auto w-full pb-24 pt-10 sm:pt-16", fullWidth ? "max-w-none px-6 sm:px-24" : "max-w-[780px] px-6 sm:px-[30px]")}>
      <PageHeading
        icon={icon}
        title={title}
        canEdit={data.canEdit}
        onTitleChange={setTitle}
        onTitleCommit={saveTitle}
        onIconChange={saveIcon}
        onEnter={() => editor?.focus()}
      />

      {!data.canEdit && (
        <p className="mb-4 rounded-[6px] bg-surface-2 px-3 py-2 text-[13px] text-text-2">{t("pageDetail.readOnly")}</p>
      )}

      <ClientOnly fallback={<div className="min-h-[40vh]" />}>
        <DocEditor
          pageId={data.page.id}
          collabToken={data.collabToken}
          collabWsUrl={data.collabWsUrl}
          canEdit={data.canEdit}
          userId={shell.user.id}
          userName={shell.user.name}
          historyButton={false}
          onEditorReady={setEditor}
        />
      </ClientOnly>

      <SubPagesSection data={data} />
      <LinkedIssuesSection data={data} />
      {data.backlinkPages.length > 0 && (
        <DocSection title={t("pageDetail.mentionedInHeading")}>
          {data.backlinkPages.map((p) => (
            <PageRow key={p.id} id={p.id} title={p.title} icon={p.icon} />
          ))}
        </DocSection>
      )}
      <CommentsSection data={data} intlLocale={intlLocale} />

      <VersionHistoryDialog
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        pageId={data.page.id}
        editor={editor}
        canRestore={data.canEdit}
      />
    </div>
  );
}

// ── Heading: icon + big title ─────────────────────────────────────────

function PageHeading({
  icon,
  title,
  canEdit,
  onTitleChange,
  onTitleCommit,
  onIconChange,
  onEnter,
}: {
  icon: string | null;
  title: string;
  canEdit: boolean;
  onTitleChange: (v: string) => void;
  onTitleCommit: () => void;
  onIconChange: (v: string | null) => void;
  onEnter: () => void;
}) {
  const { t } = useTranslation("docs");
  const [pickerOpen, setPickerOpen] = useState(false);
  const iconRef = useRef<HTMLButtonElement>(null);
  const addRef = useRef<HTMLButtonElement>(null);
  const titleRef = useRef<HTMLTextAreaElement>(null);
  const anchor = icon ? iconRef : addRef;

  // Auto-grow for browsers without CSS field-sizing.
  useLayoutEffect(() => {
    const el = titleRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [title]);

  return (
    <div className="group/heading mb-3">
      {icon ? (
        <button
          ref={iconRef}
          type="button"
          disabled={!canEdit}
          onClick={() => setPickerOpen(true)}
          aria-label={t("pageDetail.changeIcon")}
          title={canEdit ? t("pageDetail.changeIcon") : undefined}
          className="mb-2 -ml-1 grid h-[78px] w-[78px] place-items-center rounded-[8px] text-[64px] leading-none hover:bg-surface-3 disabled:hover:bg-transparent"
        >
          {icon}
        </button>
      ) : (
        canEdit && (
          <div className="mb-1 flex h-7 items-center opacity-0 transition-opacity focus-within:opacity-100 group-hover/heading:opacity-100">
            <button
              ref={addRef}
              type="button"
              onClick={() => setPickerOpen(true)}
              className="-ml-1.5 flex h-7 items-center gap-1.5 rounded-[5px] px-1.5 text-[13.5px] text-text-3 hover:bg-surface-3 hover:text-text-2"
            >
              <SmilePlus size={15} strokeWidth={1.75} />
              {t("pageDetail.addIcon")}
            </button>
          </div>
        )
      )}
      <textarea
        ref={titleRef}
        rows={1}
        value={title}
        readOnly={!canEdit}
        onChange={(e) => onTitleChange(e.target.value.replace(/\n/g, ""))}
        onBlur={onTitleCommit}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.nativeEvent.isComposing) {
            e.preventDefault();
            onTitleCommit();
            onEnter();
          }
        }}
        placeholder={t("pageDetail.titlePlaceholder")}
        aria-label={t("pageDetail.titlePlaceholder")}
        className="kp-doc-title block w-full border-none bg-transparent p-0 text-[40px] font-bold leading-[1.2] tracking-[-0.02em] text-text outline-none placeholder:text-text-3/60"
      />
      <Popover open={pickerOpen} onClose={() => setPickerOpen(false)} anchorRef={anchor} width={332} ariaLabel={t("pageDetail.iconPickerTitle")}>
        <div className="flex h-10 flex-none items-center justify-between border-b border-border px-3">
          <span className="text-[13px] font-medium text-text-2">{t("pageDetail.iconPickerTitle")}</span>
          {icon && (
            <button
              type="button"
              onClick={() => {
                onIconChange(null);
                setPickerOpen(false);
              }}
              className="rounded-[5px] px-1.5 py-0.5 text-[13px] text-text-2 hover:bg-surface-3 hover:text-text"
            >
              {t("pageDetail.removeIcon")}
            </button>
          )}
        </div>
        <div className="grid max-h-[280px] grid-cols-8 gap-0.5 overflow-y-auto p-2">
          {EMOJI.map((e) => (
            <button
              key={e}
              type="button"
              onClick={() => {
                onIconChange(e);
                setPickerOpen(false);
              }}
              className={cn("grid h-9 w-9 place-items-center rounded-[6px] text-[22px] leading-none hover:bg-surface-3", e === icon && "bg-surface-4")}
            >
              {e}
            </button>
          ))}
        </div>
      </Popover>
    </div>
  );
}

// ── Topbar pieces ─────────────────────────────────────────────────────

function SharePopover({ data }: { data: PageData }) {
  const { t, i18n } = useTranslation("docs");
  const intlLocale = INTL_LOCALE[i18n.language as SupportedLocale] ?? "en-US";
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [freshUrl, setFreshUrl] = useState<string | null>(null);
  const ref = useRef<HTMLButtonElement>(null);
  const active = data.shareLinks.filter((l) => !l.revokedAt);

  async function create(scope: "view" | "comment") {
    setBusy(true);
    try {
      const { token } = await createShareLinkFn({ data: { pageId: data.page.id, scope } });
      const url = `${window.location.origin}/s/${token}`;
      try {
        await navigator.clipboard.writeText(url);
        toast.show({ title: t("pageDetail.linkCreated") });
        setFreshUrl(null);
      } catch {
        setFreshUrl(url);
      }
      await router.invalidate();
    } finally {
      setBusy(false);
    }
  }

  async function revoke(id: string) {
    await revokeShareLinkFn({ data: id });
    await router.invalidate();
  }

  return (
    <>
      <Button ref={ref} variant="ghost" size="sm" onClick={() => setOpen(!open)} aria-expanded={open}>
        {active.length > 0 && <Globe size={14} strokeWidth={1.75} className="text-accent" />}
        {t("pageDetail.share")}
      </Button>
      <Popover open={open} onClose={() => setOpen(false)} anchorRef={ref} placement="bottom-end" width={360} ariaLabel={t("pageDetail.shareLinkHeading")}>
        {open && <PageAccessSection pageId={data.page.id} />}
        <div className="border-b border-border px-4 py-3">
          <p className="flex items-center gap-2 text-[14px] font-semibold">
            <Globe size={15} strokeWidth={1.75} className="text-text-2" />
            {t("pageDetail.shareLinkHeading")}
          </p>
          <p className="mt-0.5 text-[12.5px] leading-snug text-text-2">{t("pageDetail.shareDescription")}</p>
        </div>
        <div className="max-h-[240px] overflow-y-auto px-2 py-2">
          {data.shareLinks.length === 0 && (
            <p className="px-2 py-2 text-[13px] text-text-3">{data.page.privateOwnerId ? t("pageDetail.noShareLinksPersonal") : t("pageDetail.noShareLinksYet")}</p>
          )}
          {data.shareLinks.map((link) => (
            <div key={link.id} className="group/link flex h-9 items-center gap-2 rounded-[6px] px-2 hover:bg-surface-2">
              <Link2 size={14} strokeWidth={1.75} className={cn("flex-none", link.revokedAt ? "text-text-3" : "text-text-2")} />
              <span className={cn("min-w-0 flex-1 truncate text-[13.5px]", link.revokedAt && "text-text-3 line-through")}>
                {link.scope === "view" ? t("pageDetail.viewOnly") : t("pageDetail.canComment")}
                <span className="ml-1.5 text-[12px] text-text-3">{new Date(link.createdAt).toLocaleDateString(intlLocale, { day: "numeric", month: "short" })}</span>
              </span>
              {link.hasPassword && <Badge>{t("pageDetail.withPassword")}</Badge>}
              {link.revokedAt ? (
                <span className="text-[12px] text-text-3">{t("pageDetail.revoked")}</span>
              ) : (
                <button onClick={() => revoke(link.id)} className="rounded-[5px] px-1.5 py-0.5 text-[12.5px] text-text-2 hover:bg-danger-soft hover:text-danger">
                  {t("pageDetail.revokeLink")}
                </button>
              )}
            </div>
          ))}
        </div>
        {freshUrl && (
          <div className="border-t border-border px-4 py-2.5">
            <p className="mb-1 text-[12.5px] text-text-2">{t("pageDetail.linkCreatedNoCopy")}</p>
            <input readOnly value={freshUrl} onFocus={(e) => e.currentTarget.select()} className="kp-input text-[12.5px]" />
          </div>
        )}
        <div className="flex gap-2 border-t border-border bg-surface-2 px-4 py-3">
          <Button variant="primary" size="sm" onClick={() => create("view")} disabled={busy}>
            <Copy size={14} />
            {t("pageDetail.newLink")}
          </Button>
          <Button variant="outline" size="sm" onClick={() => create("comment")} disabled={busy}>
            {t("pageDetail.newCommentLink")}
          </Button>
        </div>
      </Popover>
    </>
  );
}

type PageAccess = Awaited<ReturnType<typeof getPageAccessFn>>;
/** A "Move to…" destination: Workspace (all null), a team, a project, or the viewer's own Private space. */
type SpaceTarget = { projectId: string | null; teamId: string | null; private?: boolean };
type PageRole = "view" | "comment" | "edit" | "full";
const PAGE_ROLES: PageRole[] = ["view", "comment", "edit", "full"];

/**
 * Who can open this page, on top of its space. Zero grants = everyone who
 * can see the space (team-scoped RLS decides that); any grant restricts it
 * to the listed people/teams (plus the super admin). Loaded when the Share
 * popover opens rather than with the page — most visits never open it.
 */
function PageAccessSection({ pageId }: { pageId: string }) {
  const { t } = useTranslation(["docs", "common"]);
  const toast = useToast();
  const router = useRouter();
  const me = useLoaderData({ from: "/_app" }).user.id;
  const [access, setAccess] = useState<PageAccess | null>(null);
  const [subject, setSubject] = useState("");
  const [role, setRole] = useState<PageRole>("edit");
  const [busy, setBusy] = useState(false);

  async function load() {
    setAccess(await getPageAccessFn({ data: pageId }));
  }
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageId]);

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    try {
      await fn();
      await load();
      // Sharing a Private page (or un-sharing the last person) moves it
      // between the sidebar's Private and Shared sections.
      await router.invalidate();
    } catch (err) {
      toast.show({ tone: "error", title: t("common:somethingWentWrong"), description: err instanceof Error ? err.message : undefined });
    } finally {
      setBusy(false);
    }
  }

  function parseSubject(value: string) {
    const [type, id] = value.split(":") as ["user" | "team", string];
    return { type, id };
  }

  if (!access) return <div className="border-b border-border px-4 py-3 text-[13px] text-text-3">{t("common:loading")}</div>;

  const granted = new Set(access.grants.map((g) => `${g.subjectType}:${g.subjectId}`));
  // Personal pages are shared with people only (core refuses teams).
  const addLabel = access.owner ? t("pageDetail.accessAddPersonPlaceholder") : t("pageDetail.accessAddPlaceholder");
  const restricted = access.grants.length > 0;

  return (
    <div className="border-b border-border px-4 py-3">
      <p className="flex items-center gap-2 text-[14px] font-semibold">
        <Lock size={15} strokeWidth={1.75} className="text-text-2" />
        {t("pageDetail.accessHeading")}
      </p>
      <p className="mt-0.5 text-[12.5px] leading-snug text-text-2">
        {access.owner
          ? restricted
            ? t("pageDetail.accessShared", { owner: access.owner.id === me ? t("pageDetail.you") : access.owner.name })
            : t("pageDetail.accessPrivate")
          : restricted
            ? t("pageDetail.accessRestricted")
            : t("pageDetail.accessOpen")}
      </p>

      {access.owner && restricted && (
        <div className="mt-2 flex h-9 items-center gap-2">
          <Avatar name={access.owner.name} size={22} />
          <span className="min-w-0 flex-1 truncate text-[13.5px]">{access.owner.name}</span>
          <span className="text-[12.5px] text-text-3">{t("pageDetail.owner")}</span>
        </div>
      )}

      {access.grants.length > 0 && (
        <div className="mt-2 flex flex-col">
          {access.grants.map((g) => (
            <div key={`${g.subjectType}:${g.subjectId}`} className="flex h-9 items-center gap-2">
              {g.subjectType === "user" ? <Avatar name={g.name} size={22} /> : <UsersRound size={16} className="mx-[3px] text-text-3" />}
              <span className="min-w-0 flex-1 truncate text-[13.5px]" title={g.detail ?? undefined}>
                {g.name}
              </span>
              {/* You can't take yourself off a Shared page (core refuses it: RLS would hide the row mid-update). */}
              {access.canManage && !(access.owner && g.subjectId === me) ? (
                <>
                  <select
                    value={g.role}
                    disabled={busy}
                    aria-label={t("pageDetail.accessRoleFor", { name: g.name })}
                    onChange={(e) => run(() => grantPageAccessFn({ data: { pageId, subject: { type: g.subjectType, id: g.subjectId }, role: e.target.value as PageRole } }))}
                    className="kp-field kp-select h-7 text-[12.5px]"
                  >
                    {PAGE_ROLES.map((r) => (
                      <option key={r} value={r}>
                        {t(`pageDetail.role.${r}`)}
                      </option>
                    ))}
                  </select>
                  <IconButton
                    aria-label={t("pageDetail.accessRemove", { name: g.name })}
                    title={t("pageDetail.accessRemove", { name: g.name })}
                    disabled={busy}
                    onClick={() => run(() => revokePageAccessFn({ data: { pageId, subject: { type: g.subjectType, id: g.subjectId } } }))}
                    className="hover:text-danger"
                  >
                    <X size={14} />
                  </IconButton>
                </>
              ) : (
                <span className="text-[12.5px] text-text-3">{t(`pageDetail.role.${g.role}`)}</span>
              )}
            </div>
          ))}
        </div>
      )}

      {access.canManage && (
        <div className="mt-2 flex gap-1.5">
          <NativeSelect value={subject} onChange={(e) => setSubject(e.target.value)} aria-label={addLabel} className="h-8 min-w-0 flex-1 text-[13px]">
            <option value="">{addLabel}</option>
            {access.candidates.teams.filter((tm) => !granted.has(`team:${tm.id}`)).length > 0 && (
              <optgroup label={t("pageDetail.accessTeams")}>
                {access.candidates.teams
                  .filter((tm) => !granted.has(`team:${tm.id}`))
                  .map((tm) => (
                    <option key={tm.id} value={`team:${tm.id}`}>
                      {tm.name}
                    </option>
                  ))}
              </optgroup>
            )}
            <optgroup label={t("pageDetail.accessPeople")}>
              {access.candidates.users
                .filter((u) => !granted.has(`user:${u.id}`))
                .map((u) => (
                  <option key={u.id} value={`user:${u.id}`}>
                    {u.name}
                  </option>
                ))}
            </optgroup>
          </NativeSelect>
          <NativeSelect value={role} onChange={(e) => setRole(e.target.value as PageRole)} aria-label={t("pageDetail.accessRole")} className="h-8 w-[104px] text-[13px]">
            {PAGE_ROLES.map((r) => (
              <option key={r} value={r}>
                {t(`pageDetail.role.${r}`)}
              </option>
            ))}
          </NativeSelect>
          <Button
            size="sm"
            variant="primary"
            disabled={busy || !subject}
            onClick={() =>
              run(async () => {
                await grantPageAccessFn({ data: { pageId, subject: parseSubject(subject), role } });
                setSubject("");
              })
            }
          >
            {t("pageDetail.accessAdd")}
          </Button>
        </div>
      )}
    </div>
  );
}

function MoreMenu(props: {
  canEdit: boolean;
  isTemplate: boolean;
  fullWidth: boolean;
  onDuplicate: () => void;
  onCopyLink: () => void;
  onToggleTemplate: () => void;
  onHistory: () => void;
  onToggleFullWidth: () => void;
  onTrash: () => void;
  currentSpace: SpaceTarget;
  onMove: (space: SpaceTarget, label: string) => void;
}) {
  const { t } = useTranslation(["docs", "nav"]);
  const shell = useLoaderData({ from: "/_app" });
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<"main" | "move">("main");
  const ref = useRef<HTMLButtonElement>(null);
  const run = (fn: () => void) => () => {
    setOpen(false);
    fn();
  };
  // Only spaces the viewer can actually see: RLS would reject a move into
  // anything else anyway (locked teams never appear; projects are already
  // RLS-filtered in the shell).
  const destinations: { key: string; label: string; icon: ReactNode; space: SpaceTarget }[] = [
    { key: "workspace", label: t("nav:workspaceDocs"), icon: <Building2 size={15} />, space: { projectId: null, teamId: null } },
    { key: "private", label: t("nav:privateDocs"), icon: <Lock size={15} />, space: { projectId: null, teamId: null, private: true } },
    ...shell.teams
      .filter((tm) => !tm.locked)
      .map((tm) => ({ key: `team:${tm.id}`, label: tm.name, icon: <UsersRound size={15} />, space: { projectId: null, teamId: tm.id } })),
    ...shell.projects.map((p) => ({
      key: `project:${p.id}`,
      label: p.name,
      icon: <ProjectIcon projectKey={p.key} size={15} />,
      space: { projectId: p.id, teamId: null },
    })),
  ];
  const isCurrent = (space: SpaceTarget) =>
    space.projectId === props.currentSpace.projectId && space.teamId === props.currentSpace.teamId && !!space.private === !!props.currentSpace.private;
  return (
    <>
      <IconButton
        ref={ref}
        aria-label={t("pageDetail.moreActions")}
        title={t("pageDetail.moreActions")}
        onClick={() => {
          setView("main");
          setOpen(!open);
        }}
        aria-expanded={open}
      >
        <MoreHorizontal size={18} strokeWidth={1.75} />
      </IconButton>
      <Popover open={open && view === "move"} onClose={() => setOpen(false)} anchorRef={ref} placement="bottom-end" width={248} role="menu">
        <MenuList>
          <MenuLabel>{t("pageDetail.moveTo")}</MenuLabel>
          <div className="max-h-[320px] overflow-y-auto">
            {destinations.map((d) => (
              <MenuItem
                key={d.key}
                icon={d.icon}
                selected={isCurrent(d.space)}
                hint={isCurrent(d.space) ? <Check size={14} /> : undefined}
                onClick={isCurrent(d.space) ? () => setOpen(false) : run(() => props.onMove(d.space, d.label))}
              >
                {d.label}
              </MenuItem>
            ))}
          </div>
        </MenuList>
      </Popover>
      <Popover open={open && view === "main"} onClose={() => setOpen(false)} anchorRef={ref} placement="bottom-end" width={248} role="menu">
        <MenuList>
          <MenuItem icon={<Link2 size={15} />} onClick={run(props.onCopyLink)}>
            {t("pageDetail.copyLink")}
          </MenuItem>
          <MenuItem icon={<CopyPlus size={15} />} onClick={run(props.onDuplicate)}>
            {t("pageDetail.duplicate")}
          </MenuItem>
          {props.canEdit && (
            <MenuItem icon={<LayoutTemplate size={15} />} onClick={run(props.onToggleTemplate)}>
              {props.isTemplate ? t("pageDetail.removeTemplate") : t("pageDetail.makeTemplate")}
            </MenuItem>
          )}
          <MenuItem icon={<History size={15} />} onClick={run(props.onHistory)}>
            {t("pageDetail.versionHistory")}
          </MenuItem>
          {props.canEdit && (
            <MenuItem icon={<FolderInput size={15} />} onClick={() => setView("move")}>
              {t("pageDetail.moveTo")}
            </MenuItem>
          )}
          <MenuSeparator />
          <MenuItem
            icon={<MoveHorizontal size={15} />}
            onClick={props.onToggleFullWidth}
            hint={
              <span className={cn("relative inline-block h-4 w-7 rounded-full transition-colors", props.fullWidth ? "bg-accent" : "bg-surface-4")}>
                <span className={cn("absolute top-0.5 h-3 w-3 rounded-full bg-white shadow transition-[left]", props.fullWidth ? "left-3.5" : "left-0.5")} />
              </span>
            }
          >
            {t("pageDetail.fullWidth")}
          </MenuItem>
          {props.canEdit && (
            <>
              <MenuSeparator />
              <MenuItem icon={<Trash2 size={15} />} danger onClick={run(props.onTrash)}>
                {t("pageDetail.archive")}
              </MenuItem>
            </>
          )}
        </MenuList>
      </Popover>
    </>
  );
}

// ── Sections below the editor ─────────────────────────────────────────

function DocSection({ title, children, action }: { title: string; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <section className="mt-10 border-t border-border pt-5">
      <div className="mb-2 flex items-center justify-between gap-3">
        <h2 className="text-[14px] font-semibold text-text-2">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

function PageRow({ id, title, icon }: { id: string; title: string; icon: string | null }) {
  const { t } = useTranslation("docs");
  return (
    <Link
      to="/docs/$pageId"
      params={{ pageId: id }}
      className="-mx-2 flex h-8 items-center gap-2 rounded-[6px] px-2 text-[15px] text-text hover:bg-surface-3"
    >
      <PageIcon icon={icon} size={17} />
      <span className={cn("truncate underline decoration-border-2 underline-offset-4", !title && "text-text-3")}>{title || t("untitled")}</span>
    </Link>
  );
}

function SubPagesSection({ data }: { data: PageData }) {
  const { t } = useTranslation("docs");
  const router = useRouter();
  const [adding, setAdding] = useState(false);

  async function addChild() {
    setAdding(true);
    try {
      const page = await createPageFn({ data: { parentPageId: data.page.id, projectId: data.page.projectId ?? undefined } });
      await router.navigate({ to: "/docs/$pageId", params: { pageId: page.id } });
      await router.invalidate();
    } finally {
      setAdding(false);
    }
  }

  if (data.children.length === 0 && !data.canEdit) return null;
  return (
    <DocSection title={t("pageDetail.subPagesHeading")}>
      <div className="flex flex-col">
        {data.children.map((child) => (
          <PageRow key={child.id} id={child.id} title={child.title} icon={child.icon} />
        ))}
        {data.canEdit && (
          <button
            type="button"
            onClick={addChild}
            disabled={adding}
            className="-mx-2 flex h-8 items-center gap-2 rounded-[6px] px-2 text-[14px] text-text-3 hover:bg-surface-3 hover:text-text-2 disabled:opacity-60"
          >
            <Plus size={16} strokeWidth={1.75} />
            {t("pageDetail.addSubPage")}
          </button>
        )}
      </div>
    </DocSection>
  );
}

function LinkedIssuesSection({ data }: { data: PageData }) {
  const { t } = useTranslation("docs");
  const router = useRouter();
  const [keyInput, setKeyInput] = useState("");
  const [linking, setLinking] = useState(false);
  const [error, setError] = useState("");
  const projectsById = new Map(data.linkedProjects.map((p) => [p.id, p]));

  async function link() {
    const value = keyInput.trim();
    if (!/^([a-zA-Z]+)-(\d+)$/.test(value)) {
      setError(t("pageDetail.linkIssueFormatError"));
      return;
    }
    setLinking(true);
    setError("");
    try {
      const { issueId } = await resolveIssueByKeyFn({ data: value });
      await linkPageToIssueFn({ data: { pageId: data.page.id, issueId } });
      setKeyInput("");
      await router.invalidate();
    } catch {
      setError(t("pageDetail.linkIssueNotFound"));
    } finally {
      setLinking(false);
    }
  }

  async function unlink(issueId: string) {
    await unlinkPageFromIssueFn({ data: { pageId: data.page.id, issueId } });
    await router.invalidate();
  }

  if (data.linkedIssues.length === 0 && !data.canEdit) return null;
  return (
    <DocSection title={t("pageDetail.linkedIssuesHeading")}>
      <div className="flex flex-col">
        {data.linkedIssues.map((issue) => {
          const project = projectsById.get(issue.projectId);
          const key = project ? `${project.key}-${issue.keySeq}` : `#${issue.keySeq}`;
          return (
            <div key={issue.id} className="group/issue -mx-2 flex h-9 items-center gap-2.5 rounded-[6px] px-2 hover:bg-surface-3">
              <FileText size={15} strokeWidth={1.75} className="flex-none text-accent" />
              {project ? (
                <Link
                  to="/issues/$teamId/$projectKey/$issueKeySeq"
                  params={{ teamId: project.teamId ?? "none", projectKey: project.key, issueKeySeq: String(issue.keySeq) }}
                  className="flex min-w-0 flex-1 items-center gap-2.5"
                >
                  <span className="type-key flex-none text-text-3">{key}</span>
                  <span className="truncate text-[14.5px] text-text hover:underline">{issue.title}</span>
                </Link>
              ) : (
                <span className="flex min-w-0 flex-1 items-center gap-2.5">
                  <span className="type-key flex-none text-text-3">{key}</span>
                  <span className="truncate text-[14.5px]">{issue.title}</span>
                </span>
              )}
              {data.canEdit && (
                <IconButton
                  size="xs"
                  aria-label={t("pageDetail.unlinkIssue")}
                  title={t("pageDetail.unlinkIssue")}
                  onClick={() => unlink(issue.id)}
                  className="opacity-0 focus-visible:opacity-100 group-hover/issue:opacity-100"
                >
                  <X size={13} />
                </IconButton>
              )}
            </div>
          );
        })}
      </div>
      {data.canEdit && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <input
            value={keyInput}
            onChange={(e) => {
              setKeyInput(e.target.value);
              setError("");
            }}
            onKeyDown={(e) => e.key === "Enter" && link()}
            placeholder={t("pageDetail.linkIssuePlaceholder")}
            aria-invalid={!!error}
            aria-label={t("pageDetail.linkIssuePlaceholder")}
            className="kp-field w-[220px] font-mono text-[13px]"
          />
          <Button variant="outline" size="sm" onClick={link} disabled={linking || !keyInput.trim()}>
            {t("pageDetail.linkIssueButton")}
          </Button>
          {error && <span className="text-[13px] text-danger">{error}</span>}
        </div>
      )}
    </DocSection>
  );
}

function CommentsSection({ data, intlLocale }: { data: PageData; intlLocale: string }) {
  const { t } = useTranslation("docs");
  const router = useRouter();
  const shell = useLoaderData({ from: "/_app" });
  const [comment, setComment] = useState("");
  const [sending, setSending] = useState(false);
  const usersById = new Map(data.users.map((u) => [u.id, u]));

  async function submit() {
    if (!comment.trim() || sending) return;
    setSending(true);
    try {
      await addPageCommentFn({ data: { pageId: data.page.id, blockId: "page", text: comment.trim() } });
      setComment("");
      await router.invalidate();
    } finally {
      setSending(false);
    }
  }

  return (
    <DocSection title={t("pageDetail.commentsHeading")}>
      <div className="flex flex-col gap-4">
        {data.comments.length === 0 && <p className="text-[14px] text-text-3">{t("pageDetail.noCommentsYet")}</p>}
        {data.comments.map((c) => {
          const author = usersById.get(c.authorId);
          const body = c.bodyJson as { text?: string } | null;
          const created = new Date(c.createdAt);
          return (
            <div key={c.id} className="flex gap-3">
              <Avatar name={author?.name ?? "?"} size={26} />
              <div className="min-w-0 flex-1">
                <p className="flex items-baseline gap-2 text-[13.5px]">
                  <span className="font-semibold text-text">{author?.name ?? t("versionHistory.unknownAuthor")}</span>
                  <span className="text-[12.5px] text-text-3" title={created.toLocaleString(intlLocale)}>
                    {relativeTime(created, intlLocale)}
                  </span>
                </p>
                <p className="mt-0.5 whitespace-pre-wrap text-[14.5px] leading-relaxed text-text">{body?.text ?? ""}</p>
              </div>
            </div>
          );
        })}
        <div className="flex gap-3">
          <Avatar name={shell.user.name} size={26} />
          <div className="min-w-0 flex-1">
            <textarea
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  submit();
                }
              }}
              placeholder={t("pageDetail.commentPlaceholder")}
              aria-label={t("pageDetail.commentPlaceholder")}
              rows={comment ? 3 : 1}
              className="kp-input min-h-9 resize-none"
            />
            {comment.trim() && (
              <div className="mt-2 flex items-center justify-end gap-3">
                <span className="text-[12px] text-text-3">{t("pageDetail.commentHint")}</span>
                <Button variant="primary" size="sm" onClick={submit} disabled={sending}>
                  {t("send")}
                </Button>
              </div>
            )}
          </div>
        </div>
      </div>
    </DocSection>
  );
}
