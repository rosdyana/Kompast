/**
 * Placeholder data matching the shapes in Kompast.dc.html, standing in for
 * @kompast/db queries until the P1 issue/board service layer lands (see
 * plan §Phases). Every route that reads this module is meant to be
 * rewired to a real TanStack Start server function, not rewritten.
 */

export const currentUser = {
  name: "Rani Adyatma",
  initials: "RA",
  role: "Maintainer",
};

export const teams = [
  {
    id: "cloud-platform",
    name: "Platform",
    color: "var(--indigo)",
    items: [
      { id: "kompast-core", glyph: "◫", name: "Kompast Core", meta: "32" },
      { id: "billing", glyph: "◫", name: "Billing Service", meta: "11" },
    ],
  },
  {
    id: "growth",
    name: "Growth",
    color: "var(--green)",
    items: [{ id: "onboarding", glyph: "◫", name: "Onboarding Revamp", meta: "8" }],
  },
];

export const stats = [
  { label: "Tiket dikerjakan", value: "18", delta: "+3", deltaColor: "var(--green)" },
  { label: "Sprint selesai", value: "86%", delta: "+4%", deltaColor: "var(--green)" },
  { label: "Blocked", value: "4", delta: "+1", deltaColor: "var(--accent)" },
  { label: "Doc baru minggu ini", value: "6", delta: "+2", deltaColor: "var(--green)" },
];

export const miniColumns = [
  {
    name: "Backlog",
    color: "var(--text3)",
    count: 12,
    cards: [{ key: "KPT-88", title: "Audit rate limit di API gateway" }],
  },
  {
    name: "In Progress",
    color: "var(--indigo)",
    count: 6,
    cards: [{ key: "KPT-91", title: "Migrasi worker ke BullMQ" }],
  },
  {
    name: "Review",
    color: "var(--amber)",
    count: 3,
    cards: [{ key: "KPT-84", title: "PR: RLS untuk tabel issue" }],
  },
  {
    name: "Done",
    color: "var(--green)",
    count: 11,
    cards: [{ key: "KPT-79", title: "Setup Hocuspocus persistence" }],
  },
];

export const autoFeed = [
  {
    glyph: "⚡",
    bg: "var(--indigo-soft)",
    fg: "var(--indigo)",
    text: "Auto-assign ke Rani karena label \"backend\"",
    rule: "Assign berdasarkan label",
    time: "12m lalu",
  },
  {
    glyph: "✉",
    bg: "var(--green-soft)",
    fg: "var(--green)",
    text: "Notifikasi email dikirim ke pelapor saat KPT-79 selesai",
    rule: "Notifikasi selesai",
    time: "1j lalu",
  },
];

export const recentDocs = [
  {
    title: "RFC: Automation engine v1",
    excerpt: "Trigger, kondisi, dan aksi berjalan lewat outbox transaksional…",
    tag: "RFC",
    bg: "var(--indigo-soft)",
    fg: "var(--indigo)",
    meta: "Diubah 2j lalu",
  },
  {
    title: "Runbook: restore Postgres",
    excerpt: "Langkah pemulihan dari pg_dump harian ke instance baru…",
    tag: "Runbook",
    bg: "var(--green-soft)",
    fg: "var(--green)",
    meta: "Diubah kemarin",
  },
];

export const myTasks = [
  { title: "Review PR RLS tenant isolation", due: "Hari ini", dueColor: "var(--accent)" },
  { title: "Tulis dry-run report importer JIRA", due: "Besok", dueColor: "var(--text3)" },
];

interface BoardCard {
  key: string;
  type: string;
  typeBg: string;
  typeFg: string;
  title: string;
  blocked?: boolean;
  labels: { t: string; bg: string; fg: string }[];
  av: string;
  avBg: string;
  avFg: string;
  due: string;
  dueColor: string;
  comments: number;
  points: number;
}

interface BoardColumn {
  id: string;
  name: string;
  color: string;
  canDelete: boolean;
  isBacklog?: boolean;
  overWip?: boolean;
  wipText?: string;
  cards: BoardCard[];
}

export const boardColumns: BoardColumn[] = [
  {
    id: "backlog",
    name: "Backlog",
    color: "var(--text3)",
    isBacklog: true,
    canDelete: false,
    cards: [
      {
        key: "KPT-88",
        type: "TASK",
        typeBg: "var(--indigo-soft)",
        typeFg: "var(--indigo)",
        title: "Audit rate limit di API gateway",
        labels: [{ t: "backend", bg: "var(--surface-3)", fg: "var(--text-2)" }],
        av: "RA",
        avBg: "var(--violet-soft)",
        avFg: "var(--violet)",
        due: "12 Sep",
        dueColor: "var(--text-3)",
        comments: 2,
        points: 3,
      },
    ],
  },
  {
    id: "todo",
    name: "To Do",
    color: "var(--indigo)",
    canDelete: true,
    cards: [
      {
        key: "KPT-90",
        type: "STORY",
        typeBg: "var(--green-soft)",
        typeFg: "var(--green)",
        title: "Desain skema saved_view untuk table mode",
        labels: [],
        av: "DK",
        avBg: "var(--indigo-soft)",
        avFg: "var(--indigo)",
        due: "10 Sep",
        dueColor: "var(--text-3)",
        comments: 0,
        points: 5,
      },
    ],
  },
  {
    id: "in-progress",
    name: "In Progress",
    color: "var(--amber)",
    canDelete: true,
    overWip: true,
    wipText: "5/4 — di atas batas WIP",
    cards: [
      {
        key: "KPT-91",
        type: "TASK",
        typeBg: "var(--indigo-soft)",
        typeFg: "var(--indigo)",
        title: "Migrasi worker ke BullMQ",
        blocked: true,
        labels: [{ t: "infra", bg: "var(--surface-3)", fg: "var(--text-2)" }],
        av: "RA",
        avBg: "var(--violet-soft)",
        avFg: "var(--violet)",
        due: "8 Sep",
        dueColor: "var(--accent)",
        comments: 5,
        points: 8,
      },
    ],
  },
  {
    id: "review",
    name: "Review",
    color: "var(--violet)",
    canDelete: true,
    cards: [
      {
        key: "KPT-84",
        type: "TASK",
        typeBg: "var(--indigo-soft)",
        typeFg: "var(--indigo)",
        title: "PR: RLS untuk tabel issue",
        labels: [],
        av: "DK",
        avBg: "var(--indigo-soft)",
        avFg: "var(--indigo)",
        due: "6 Sep",
        dueColor: "var(--text-3)",
        comments: 3,
        points: 3,
      },
    ],
  },
  {
    id: "done",
    name: "Done",
    color: "var(--green)",
    canDelete: true,
    cards: [
      {
        key: "KPT-79",
        type: "TASK",
        typeBg: "var(--indigo-soft)",
        typeFg: "var(--indigo)",
        title: "Setup Hocuspocus persistence",
        labels: [],
        av: "RA",
        avBg: "var(--violet-soft)",
        avFg: "var(--violet)",
        due: "",
        dueColor: "var(--text-3)",
        comments: 1,
        points: 2,
      },
    ],
  },
];
