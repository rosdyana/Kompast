---
name: Kompast
description: One self-hosted workspace for docs and issue tracking. Calm, Notion-style structure for writing, dense Jira-style vocabulary for tracking, tied together by the navy and cobalt compass mark.
colors:
  bg: "#fbfbfa"
  surface: "#ffffff"
  surface2: "#f6f5f2"
  surface3: "#efede9"
  surface4: "#e6e4df"
  text: "#2f2e2a"
  text2: "#605e59"
  text3: "#75736d"
  border: "#eae8e3"
  border2: "#dbd8d1"
  accent: "#3a70dc"
  accent-hover: "#3063c8"
  accent-text: "#2d62c9"
  accent-soft: "#ebf1fc"
  indigo: "#2a4674"
  indigo-soft: "#e9ecf3"
  green: "#2d7a58"
  green-soft: "#e4f1ea"
  amber: "#93661d"
  amber-soft: "#f7eedc"
  violet: "#6953b3"
  violet-soft: "#efecf8"
  danger: "#bf4a3b"
  danger-soft: "#f8eae7"
typography:
  display:
    fontFamily: "ui-sans-serif, -apple-system, BlinkMacSystemFont, Segoe UI Variable Text, Segoe UI, Helvetica Neue, Helvetica, Arial, PingFang TC, Microsoft JhengHei, Noto Sans TC, sans-serif"
    fontSize: "30px"
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: "-0.02em"
  doc-title:
    fontFamily: "ui-sans-serif, -apple-system, BlinkMacSystemFont, Segoe UI Variable Text, Segoe UI, Helvetica Neue, Helvetica, Arial, PingFang TC, Microsoft JhengHei, Noto Sans TC, sans-serif"
    fontSize: "40px"
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: "-0.02em"
  title:
    fontFamily: "ui-sans-serif, -apple-system, BlinkMacSystemFont, Segoe UI Variable Text, Segoe UI, Helvetica Neue, Helvetica, Arial, PingFang TC, Microsoft JhengHei, Noto Sans TC, sans-serif"
    fontSize: "22px"
    fontWeight: 650
    lineHeight: 1.25
    letterSpacing: "-0.015em"
  headline:
    fontFamily: "ui-sans-serif, -apple-system, BlinkMacSystemFont, Segoe UI Variable Text, Segoe UI, Helvetica Neue, Helvetica, Arial, PingFang TC, Microsoft JhengHei, Noto Sans TC, sans-serif"
    fontSize: "15px"
    fontWeight: 600
    lineHeight: 1.35
    letterSpacing: "-0.005em"
  doc-body:
    fontFamily: "ui-sans-serif, -apple-system, BlinkMacSystemFont, Segoe UI Variable Text, Segoe UI, Helvetica Neue, Helvetica, Arial, PingFang TC, Microsoft JhengHei, Noto Sans TC, sans-serif"
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1.65
  body:
    fontFamily: "ui-sans-serif, -apple-system, BlinkMacSystemFont, Segoe UI Variable Text, Segoe UI, Helvetica Neue, Helvetica, Arial, PingFang TC, Microsoft JhengHei, Noto Sans TC, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.5
  small:
    fontFamily: "ui-sans-serif, -apple-system, BlinkMacSystemFont, Segoe UI Variable Text, Segoe UI, Helvetica Neue, Helvetica, Arial, PingFang TC, Microsoft JhengHei, Noto Sans TC, sans-serif"
    fontSize: "12.5px"
    fontWeight: 400
    lineHeight: 1.45
  label:
    fontFamily: "ui-sans-serif, -apple-system, BlinkMacSystemFont, Segoe UI Variable Text, Segoe UI, Helvetica Neue, Helvetica, Arial, PingFang TC, Microsoft JhengHei, Noto Sans TC, sans-serif"
    fontSize: "12px"
    fontWeight: 500
    lineHeight: 1.3
    fontFeature: "tnum"
  label-overline:
    fontFamily: "ui-sans-serif, -apple-system, BlinkMacSystemFont, Segoe UI Variable Text, Segoe UI, Helvetica Neue, Helvetica, Arial, PingFang TC, Microsoft JhengHei, Noto Sans TC, sans-serif"
    fontSize: "12px"
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: "0.04em"
  key:
    fontFamily: "JetBrains Mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"
    fontSize: "11.5px"
    fontWeight: 500
    lineHeight: 1.3
    letterSpacing: "-0.01em"
    fontFeature: "tnum"
rounded:
  xs: "4px"
  sm: "5px"
  md: "6px"
  lg: "8px"
  xl: "10px"
  full: "9999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
  2xl: "32px"
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "#ffffff"
    rounded: "{rounded.md}"
    padding: "0 12px"
    height: "32px"
  button-primary-hover:
    backgroundColor: "{colors.accent-hover}"
  button-outline:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.md}"
    padding: "0 12px"
    height: "32px"
  button-outline-hover:
    backgroundColor: "{colors.surface2}"
  button-secondary:
    backgroundColor: "{colors.surface3}"
    textColor: "{colors.text}"
    rounded: "{rounded.md}"
    padding: "0 12px"
    height: "32px"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.text2}"
    rounded: "{rounded.md}"
    padding: "0 12px"
    height: "32px"
  button-ghost-hover:
    backgroundColor: "{colors.surface3}"
    textColor: "{colors.text}"
  button-subtle:
    backgroundColor: "transparent"
    textColor: "{colors.accent-text}"
    rounded: "{rounded.md}"
    padding: "0 12px"
    height: "32px"
  button-subtle-hover:
    backgroundColor: "{colors.accent-soft}"
  button-danger:
    backgroundColor: "{colors.danger}"
    textColor: "#ffffff"
    rounded: "{rounded.md}"
    padding: "0 12px"
    height: "32px"
  input:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "5px 10px"
    height: "32px"
  input-compact:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.md}"
    padding: "3px 8px"
  badge:
    backgroundColor: "{colors.surface3}"
    textColor: "{colors.text2}"
    rounded: "{rounded.xs}"
    padding: "0 6px"
    height: "20px"
  lozenge:
    rounded: "{rounded.xs}"
    padding: "0 6px"
    height: "20px"
  kbd:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text3}"
    rounded: "{rounded.xs}"
    height: "18px"
  sidebar:
    backgroundColor: "{colors.surface2}"
    width: "248px"
  sidebar-row:
    textColor: "{colors.text2}"
    rounded: "{rounded.md}"
    padding: "0 8px"
    height: "30px"
  sidebar-row-hover:
    backgroundColor: "{colors.surface3}"
    textColor: "{colors.text}"
  sidebar-row-active:
    backgroundColor: "{colors.surface4}"
    textColor: "{colors.text}"
  topbar:
    backgroundColor: "{colors.bg}"
    height: "44px"
  card:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.xl}"
  kanban-lane:
    backgroundColor: "{colors.surface2}"
    rounded: "{rounded.xl}"
    width: "280px"
  kanban-card:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.lg}"
    padding: "12px"
  menu-item:
    textColor: "{colors.text}"
    rounded: "{rounded.sm}"
    padding: "4px 8px"
    height: "32px"
  dialog:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.xl}"
    width: "560px"
  table-row:
    backgroundColor: "{colors.surface}"
    height: "38px"
  tabs:
    textColor: "{colors.text2}"
    height: "36px"
    padding: "0 10px"
  switch:
    backgroundColor: "{colors.surface4}"
    rounded: "{rounded.full}"
    height: "20px"
    width: "36px"
---

# Design System: Kompast

## Overview

**Creative North Star: "The Workbench"**

Kompast is a workbench, not a showroom: two familiar tools laid on one calm, warm-gray table. Docs take Notion's structure: a labeled 248px sidebar with a page tree and favorites, a big emoji icon over a 40px bold title, and a 16px reading column with generous line height. Tracking takes Jira's vocabulary: status lozenges, colored issue-type tiles, priority chevrons, dense backlog rows inside sprint containers, kanban lanes of raised cards, an inline-editable table, a detail page with quiet click-to-edit fields, a ⌘K palette, and a global Create issue dialog. People who have used either tool daily should feel at home within seconds. That is the point, because this is a migration target.

What makes it Kompast and not a clone is the brand pair and the temperature. A deep navy tile holding a cobalt diamond (the compass mark) anchors the shell and the sign-in panel. Everything else sits on warm neutrals tuned for eye comfort: an off-white canvas, warm dark-gray ink, one calm mid-saturation blue, and low-chroma status hues. Dark mode is soft charcoal, never black. Type is the operating system's own UI face, chosen for native rendering and first-class CJK coverage across the English, Bahasa Indonesia, and Traditional Chinese locales. JetBrains Mono appears in exactly one place: issue keys.

Density is set per surface. Docs breathe; tracking packs rows at 30 to 38px. Chrome stays quiet so that the colored data (lozenges, type tiles, priority arrows, avatars) is what the eye reads first.

**Key Characteristics:**
- Warm off-white canvas (never pure white) with white raised surfaces and hairline warm borders.
- One blue accent for action, focus, and selection. Navy is reserved for brand.
- System UI sans for everything, mono only for issue keys.
- Jira-native tracking glyphs: bold uppercase lozenges, 16px type tiles, chevron priorities.
- Soft, layered ambient shadows for cards and overlays only. No hard offsets.
- 6px controls, 8px cards and popovers, 10px containers and dialogs.
- Token names are a data contract: colors are stored in the database as `var(--name)` strings.

## Colors

A warm-neutral workshop palette: near-white paper, graphite ink, one calm cobalt, and a muted set of status hues that read clearly without glare.

### Primary
- **Calm Cobalt** (accent): the single action and focus color. Used for primary buttons, the focus ring and outline, the text caret, selected menu checks, active tab underlines, drop targets, the Spinner arc, and checkbox tint. Hover deepens to **Cobalt Pressed** (accent-hover). **Cobalt Ink** (accent-text) is the text-safe variant for links, subtle buttons, active tab labels, and in-progress lozenges. **Cobalt Wash** (accent-soft) is the 3px focus halo and the selected or drop-over fill.

### Secondary
- **Compass Navy** (indigo): the brand color. It fills the compass mark tile and the sign-in brand panel, tints custom-field chips on cards, and is the first project-tile and column-tone preset. **Navy Mist** (indigo-soft) is its chip background.

### Tertiary (status hues, low chroma)
- **Ledger Green** (green) and **Green Mist** (green-soft): done status, the story type tile, success toasts.
- **Ochre** (amber) and **Ochre Mist** (amber-soft): medium priority and warning tones.
- **Muted Violet** (violet) and **Violet Mist** (violet-soft): the epic type tile and epic chips on cards and backlog rows.
- **Clay Red** (danger) and **Clay Mist** (danger-soft): bugs, highest priority, overdue dates, destructive buttons, error text, and invalid field borders. Inline code in docs uses a Clay tint mixed 8% into surface3.

### Neutral
- **Workbench Paper** (bg): the page canvas and the topbar. Also the browser `theme-color`.
- **Card White** (surface): raised things that sit on the canvas: cards, inputs, popovers, dialogs, table bodies.
- **Sidebar Linen** (surface2): the sidebar column, kanban lanes, sprint containers, table headers, dialog footers, code blocks, and the automation canvas.
- **Hover Linen** (surface3): the universal hover fill, the secondary button, neutral badges, count pills, and the pill-tab track.
- **Pressed Linen** (surface4): the active sidebar row, pressed states, and neutral avatars.
- **Graphite Ink** (text): body text, at roughly 11:1 on the canvas.
- **Slate Ink** (text2): secondary text, ghost button labels, and todo lozenges.
- **Stone Ink** (text3): placeholders, icons in nav rows, issue keys at rest, hints, and field hover borders.
- **Hairline** (border) and **Hairline Deep** (border2): structural dividers, and control or table-cell borders.

Dark mode redefines every name under `[data-theme="dark"]` (canvas `#1f1f1e`, ink `#dfded9`, accent `#6f9bef`). Components never branch on theme. They read the same names.

### Named Rules
**The Stored Name Rule.** Issue types, statuses, columns, and priority levels store their color in the database as `var(--name)` strings (for example `var(--text3)`, `var(--indigo)`, `var(--amber)`). Retune any value freely. Never rename or remove a token name, or existing data silently loses its color.

**The Comfortable Contrast Rule.** No pure-white canvas and no pure-black text. The canvas is `bg`, the ink is `text`, and dark mode is charcoal with off-white ink. Pure white appears only as the Card White surface and as the mark on saturated fills (primary and danger buttons, type tiles, project tiles).

**The One Blue Rule.** Cobalt means "act here" or "you are here": action, focus, selection. Navy is the brand, not a second interactive color.

## Typography

**Display Font:** System UI stack (ui-sans-serif, -apple-system, Segoe UI Variable Text, Segoe UI, Helvetica Neue, then PingFang TC, Microsoft JhengHei, Noto Sans TC)
**Body Font:** The same stack
**Label/Mono Font:** JetBrains Mono (with ui-monospace, SFMono-Regular, Menlo, Consolas), used for issue keys and code only

**Character:** One native family on a tight scale of about 1.15. It renders like the OS, costs no font download, and handles Latin-extended and Traditional Chinese equally well. Hierarchy comes from weight (400, 500, 600, 650, 700) and size, never from a second display family.

### Hierarchy
- **Display** (700, 30px, 1.2, -0.02em): the largest product heading.
- **Doc Title** (700, 40px, 1.2, -0.02em): the Notion-style page title. It is an auto-growing textarea under a 64px emoji icon.
- **Title** (650, 22px, 1.25): page headers (PageHeader) for settings, teams, tokens, and the docs index.
- **Headline** (600, 15px, 1.35): card headers, empty-state titles, and dialog titles (set to 17px in Dialog).
- **Doc Body** (400, 16px, 1.65): the doc reading column. Doc headings follow Notion's scale: 1.875em, 1.5em, and 1.25em at 650 weight, with more air above than below.
- **Body** (400, 14px, 1.5): the app default for rows, fields, buttons, and descriptions.
- **Small** (400, 12.5px, 1.45): hints, descriptions, and metadata lines.
- **Label** (500, 12px, tabular numerals): counts, dates, and story points.
- **Label Overline** (600, 12px, 0.04em, uppercase): the one uppercase label style: kanban column headers, roadmap and import table heads, the doc board embed, and section labels inside menus ("Move to"). Never hand-roll another uppercase label.
- **Key** (JetBrains Mono 500, 11.5px, tabular numerals): issue keys such as KPT-12. They are Stone Ink at rest and Cobalt Ink on hover.

### Named Rules
**The Literal Data Rule.** Mono is only for things that are literally data: issue keys and code. Counts, dates, and timestamps use the sans with tabular numerals.

**The One Family Rule.** No webfont display face and no serif. A heading is louder because of weight and size, not because of a different family.

## Layout

The shell is a sidebar plus a main column. The sidebar is 248px on desktop and can be hidden entirely (⌘\, persisted in localStorage). Below 768px it becomes a 272px overlay drawer on the scrim, with the ambient shadow. Its width transition (200ms ease-out) is gated behind mount so the first paint never animates. The main column opens with a 44px topbar: a breadcrumb trail with chevron separators, contextual actions, a shortcuts button, and a small primary Create button.

Page content lives in a PageContainer with named widths: narrow 560px, standard 720px, wide 880px, reading 900px, dense 1200px, and full. Padding is 20px on the sides and 24px on top on mobile, 32px and 32px from `sm` up, with 64px at the bottom. The doc page has its own 780px column (switchable to full width) with 40 to 64px of top air. The issue detail page is a 1240px frame: a main column of up to 780px beside a 320px field column from `lg` up.

Tracking is horizontal and dense. Kanban lanes are fixed at 280px and scroll sideways. Backlog rows sit inside bordered sprint containers. Table rows are 38px with a sticky Sidebar Linen header. Sidebar rows are 30px; menu rows are at least 32px. Spacing follows a 4px base (4, 8, 12, 16, 24, 32).

## Elevation & Depth

This is a hybrid system. Structure comes from tonal layering: a Sidebar Linen column and lanes, Card White surfaces on a Paper canvas, and hairline borders. Soft, warm-tinted ambient shadows mark only two things: a card that can be picked up, and a surface that floats above the page. All shadows are built from a 1px ring plus diffuse blur, tinted with the ink color `rgba(40,38,33,…)`. None is a hard offset.

### Shadow Vocabulary
- **Card** (`box-shadow: 0 1px 1px rgba(40,38,33,0.05), 0 0 0 1px rgba(40,38,33,0.06)`): kanban cards at rest, the active pill tab, toggle knobs, and the automation canvas controls.
- **Lift** (`box-shadow: 0 0 0 1px rgba(40,38,33,0.05), 0 10px 24px -6px rgba(40,38,33,0.22)`): kanban card hover and drag, and the backlog row drag preview.
- **Overlay** (`box-shadow: 0 0 0 1px rgba(40,38,33,0.05), 0 4px 10px -2px rgba(40,38,33,0.08), 0 16px 36px -12px rgba(40,38,33,0.18)`): popovers, menus, select menus, dialogs, toasts, and the mobile sidebar drawer.
- **Focus Halo** (`box-shadow: 0 0 0 3px var(--accent-soft)`): focused fields, search fields, and pill selects.

### Named Rules
**The Lift Means Movable Rule.** A resting shadow belongs on a kanban card because it can be dragged; hover raises it to Lift. Static containers (Card, sprint containers, tables) use a border or a tonal fill, never a shadow.

## Shapes

Corners are gently rounded and step up with the size of the object. 4px is for tags and glyphs (badges, lozenges, type tiles, Kbd, inline code). 5px is for menu items and project tiles. 6px is for every control (buttons, inputs, sidebar rows, the search field). 8px is for kanban cards, popovers, toasts, and table frames. 10px is for large containers (Card, Dialog, kanban lanes, sprint containers, panel empty states). Avatars, count pills, and status dots are full circles. The unassigned avatar is a dashed circle, and empty-state panels use a dashed Hairline Deep border. The compass mark is a navy square at a 28% radius holding a 45°-rotated cobalt square.

## Components

### Buttons
Quiet, compact, and flat. Color is saved for the one action that matters.
- **Shape:** 6px radius, medium weight, a 6px icon gap. Heights are xs 24px (12px text), sm 28px (13px), md 32px (14px, the default), and lg 40px (14px). The icon-only form is square at the same heights.
- **Primary:** a Calm Cobalt fill with white text and a 1px inner bottom shade. Hover moves to accent-hover.
- **Outline (default):** Card White with a Hairline Deep border. Hover goes to surface2, press to surface3.
- **Secondary:** a Hover Linen fill; hover goes to surface4.
- **Ghost:** Slate Ink text with no fill. Hover shows the surface3 fill and Graphite text. IconButton is a ghost at sm (28px), the toolbar and row-action workhorse.
- **Subtle:** Cobalt Ink text with a Cobalt Wash hover.
- **Dark / Danger:** an ink fill or a Clay Red fill; hover dips opacity to 90%.
- **States:** a 100ms color transition. Disabled buttons sit at 50% opacity with no pointer events. Keyboard focus draws the global 2px cobalt outline.

### Chips
- **Badge:** 20px tall, 4px radius, 11.5px medium, in seven tones (neutral, accent, indigo, green, amber, violet, danger). Each tone is its `-soft` fill with the full-strength text.
- **Card chips:** epics use violet on violet-soft, labels use text2 on surface3, custom fields use indigo on indigo-soft, and an overflow chip reads "+N".
- **CountPill:** an 18px circle-pill with 11px semibold tabular text on surface3.

### Status Lozenge (signature)
Jira's most recognizable glyph. It is 20px tall with a 4px radius. The bold form is 11px, 700 weight, uppercase, with 0.03em tracking; the subtle form is 12px medium in sentence case. The text is the status color, and the fill is that same color mixed 14% into surface. With no stored color, the category decides: todo uses text2, in progress uses accent-text, and done uses green. StatusDot is an 8px circle for column headers and dense lists.

### Issue Type Tile and Priority Chevron (signature)
- **Type tile:** a 16px square with a 4px radius, a colored fill, and a white Lucide mark (stroke 2.75, 66% of the tile). Epic is a violet tile with a filled bolt, story is green with a filled bookmark, bug is danger with a bug mark, task is accent with a check, and subtask is accent with a corner arrow. Custom types use their stored color.
- **Priority:** Lucide chevrons at 16px with stroke 2.5. Critical, highest, and blocker use a danger double-up. High is a single up in danger mixed 70% with amber. Medium is an amber equals sign. Low is an accent single-down, and lowest is an accent double-down. Admin-created levels fall back to an 8px dot in their own color.

### Avatars
Circles, 22px by default, with initials at 40% of the size in semibold. The tone is hashed from the person's name across six tones, so a teammate has the same color everywhere. Unassigned is a dashed Stone Ink circle on surface. Project tiles are rounded squares at 5px with a bold white first letter on a color hashed from the key, drawn from the seven `--tile-1`…`--tile-7` tokens, which have their own dark-mode values.

### Cards / Containers
- **Card:** a 10px radius, a Hairline border, and Card White. CardHeader is a 16px by 12px row with a Headline title, a Small description, and actions on the right, above a Hairline divider.
- **Kanban lane:** 280px wide, Sidebar Linen, 10px radius. The column name is set in uppercase 12px semibold Slate Ink.
- **Kanban card:** Card White, 8px radius, 12px padding, and the Card shadow, rising to Lift on hover. The drag overlay is 264px wide and tilted 1.5°. A drop target shows a Cobalt Wash fill with a dashed accent outline.
- **Sprint container:** a 10px radius, a Hairline border, and a Sidebar Linen fill. Drop-over shifts the border to accent and the fill to a Cobalt Wash tint. Rows sit in a Card White list with a 6px radius, and the drop position is a 2px accent line.
- **Empty state:** centered, 48px of vertical padding, and an optional 40px icon tile on surface3. It has a Headline title, a Small description capped at 420px, and one action. The panel variant is dashed and sits on surface2.

### Inputs / Fields
- **Standard field:** at least 32px tall, a 6px radius, a Hairline Deep border, Card White, 5px by 10px padding, and 14px text. Hover moves the border to Stone Ink. Focus moves the border to accent with the 3px Cobalt Wash halo, over a 120ms transition.
- **Compact field:** the same frame at 3px by 8px and 13px, for dense property rows and toolbars.
- **Quiet field:** borderless and transparent at rest. Hover shows the surface3 fill; focus shows Card White, an accent border, and the halo. This is the click-to-edit look for the detail page and table cells.
- **Select:** native `<select>` with a themed 12px chevron. Pill select is the colored status control (the stored color set inline, with the halo on focus).
- **Error / Disabled:** `aria-invalid` sets a danger border, and error text is 12.5px danger. Disabled fields drop to 60% opacity on surface2.
- **FormField:** a 13px medium Slate label, the control, then a 12.5px hint or error, stacked with a 6px gap. A required field shows a danger asterisk.
- **SearchField:** a 32px framed row with a 15px Stone search icon and the same hover and focus treatment as the standard field.

### Navigation
- **Sidebar:** a Sidebar Linen column. The workspace switcher sits in a 48px header, followed by Search (with a ⌘K hint that appears on hover) and New page. Section labels are 12px semibold Stone Ink in sentence case, and their actions appear on hover. Rows are 30px with a 6px radius, 14px Slate text, and an 18px Stone icon slot. Hover shows surface3 with Graphite text; the active row is surface4, medium weight, Graphite. Project rows swap the project tile for a disclosure chevron on hover, and nested view rows are 28px, indented 34px.
- **Topbar:** 44px, on the Paper canvas, with a Hairline bottom border. Breadcrumbs are 14px: the last crumb is medium Graphite and earlier crumbs are Slate.
- **Tabs:** the underline variant is the page navigation. Tabs are 36px, 14px text, with a 2px accent bar when active and Cobalt Ink labels. The pill variant is a segmented control for sub-views: a surface3 track and a Card White active segment with the Card shadow.
- **Menus and popovers:** Card White, an 8px radius, a Hairline border, and the Overlay shadow, opening with the 140ms pop animation. Menu rows are at least 32px, 13.5px text, with a 5px radius and a surface3 hover. The selected row gets an accent check, and danger rows use Clay text.
- **Dialog:** on the ink scrim (`--overlay`), sized sm 420px, md 560px, lg 720px, or xl 920px. It has a 10px radius and a Headline title at 17px. The footer is on surface2 above a Hairline divider. The ⌘K palette and the global Create issue dialog both use it.
- **Switch:** the one on/off control (`@kompast/ui/Switch`): a native checkbox with `role="switch"` under a 36×20px surface4 track that turns accent when on, and a surface-colored knob (not pure white) with the Card shadow. The label is visible by default; `srOnlyLabel` hides it in dense rows and toolbars.
- **Kbd:** an 18px key hint with a 4px radius, a Hairline Deep border, Card White, and 11px medium Stone text.
- **Toast:** bottom-left, 360px wide, Card White with the Overlay shadow and an 8px radius. It shows a status icon (green success, danger error, accent info) and dismisses after 5 seconds.

### Motion
Motion is brief and quiet. Popovers, dialogs, and toasts use a pop animation (140ms, cubic-bezier(0.16, 1, 0.3, 1), 2px rise and 0.985 scale). Scrims use a 140ms fade. Loading uses a 1.4s shimmer skeleton or a 2px accent Spinner. Control transitions run 100 to 120ms. Every animation is disabled under `prefers-reduced-motion`.

## Do's and Don'ts

### Do:
- **Do** read every color through its token name (`var(--accent)`, `bg-surface-3`) so light and dark mode follow automatically, and keep the raw names (`--text3`, `--indigo`, `--amber`, …) stable because the database stores them.
- **Do** keep the canvas off-white (`#fbfbfa`) and the ink warm dark gray (`#2f2e2a`). Dark mode stays charcoal (`#1f1f1e`).
- **Do** use Calm Cobalt for the one primary action per view, for focus, and for selection. Everything else is outline, ghost, or subtle.
- **Do** show tracking state with the shared glyphs: Lozenge for status, IssueTypeIcon for type, PriorityIcon for priority, and Avatar for people.
- **Do** use the quiet field (borderless until hover) for inline, click-to-edit values in detail panels and table cells.
- **Do** use the system UI stack for all text, and `type-key` (JetBrains Mono) only for issue keys.
- **Do** match radius to size: 4px for glyphs, 6px for controls, 8px for cards and popovers, 10px for containers and dialogs.

### Don't:
- **Don't** rename or delete a color token; retune its value instead.
- **Don't** use a pure-white page canvas or pure-black text, and don't use black for the dark theme.
- **Don't** introduce a second display family, serif, or webfont heading face.
- **Don't** use mono for counts, dates, or timestamps; use tabular sans numerals.
- **Don't** put resting shadows on static containers, and don't use hard, offset shadows anywhere.
- **Don't** use Compass Navy as an interactive or hover color. It is the brand mark.
- **Don't** raise status-hue saturation. The low-chroma tones are a comfort requirement, not a placeholder.
