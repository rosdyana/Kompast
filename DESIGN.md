---
name: Kompast
description: One home for sprints and team knowledge — docs, tables, kanban, and automation in one workspace.
colors:
  bg: "#f6f4ef"
  surface: "#ffffff"
  surface-2: "#fbf9f5"
  surface-3: "#efece4"
  text: "#191a1d"
  text-2: "#5b5d63"
  text-3: "#8f9198"
  border: "#e4e0d8"
  border-2: "#d3cec3"
  accent: "#2f6fea"
  accent-soft: "#e8f0fe"
  indigo: "#1b3a6b"
  indigo-soft: "#e7eaf3"
  green: "#1c7a54"
  green-soft: "#dff0e8"
  amber: "#9a6410"
  amber-soft: "#faedd4"
  violet: "#584a86"
  violet-soft: "#ebe7f6"
  danger: "#c9432a"
  danger-soft: "#fae9e4"
typography:
  display:
    fontFamily: "Instrument Serif, Georgia, serif"
    fontSize: "clamp(2.5rem, 5vw, 3.25rem)"
    fontWeight: 400
    lineHeight: 1.04
    letterSpacing: "-0.01em"
  title:
    fontFamily: "Instrument Sans, ui-sans-serif, system-ui, sans-serif"
    fontSize: "clamp(1.1rem, 2vw, 1.5625rem)"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "-0.01em"
  body:
    fontFamily: "Instrument Sans, ui-sans-serif, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "normal"
  label:
    fontFamily: "JetBrains Mono, monospace"
    fontSize: "10.5px"
    fontWeight: 500
    lineHeight: 1.3
    letterSpacing: "0.1em"
rounded:
  xs: "7px"
  sm: "9px"
  md: "10px"
  lg: "12px"
  full: "9999px"
spacing:
  2xs: "2px"
  xs: "6px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "#ffffff"
    rounded: "{rounded.xs}"
    padding: "6px 12px"
  button-primary-hover:
    backgroundColor: "{colors.accent}"
  button-dark:
    backgroundColor: "{colors.text}"
    textColor: "{colors.bg}"
    rounded: "{rounded.xs}"
    padding: "14px 12px"
  button-outline:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text-2}"
    rounded: "{rounded.xs}"
    padding: "6px 12px"
  card:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.lg}"
  badge-neutral:
    backgroundColor: "{colors.surface-3}"
    textColor: "{colors.text-3}"
    rounded: "{rounded.full}"
    padding: "2px 8px"
  badge-accent:
    backgroundColor: "{colors.accent-soft}"
    textColor: "{colors.accent}"
    rounded: "{rounded.full}"
    padding: "2px 8px"
---

# Design System: Kompast

## Overview

**Creative North Star: "The Compass Ledger"**

Kompast reads like a precise paper instrument, not a glossy SaaS dashboard: a warm, off-white ledger page (`--bg`) holds dense rows of small, exact type, with a single cobalt-blue mark — sampled straight from the compass logo — as the only loud color anywhere in the system. The compass mark itself (a rotated white square inside a rounded-square cobalt tile) recurs as the system's one recognizable shape; everything else is quiet geometry — hairline borders, small pills, a diamond of negative space — never an icon library.

The system is calm, precise, and unshowy on purpose. It explicitly rejects two easy defaults: it is not a playful, illustrated Notion clone, and it is not a loud, high-contrast dark-mode developer tool. Depth comes from borders and tonal surface steps, not shadow; personality comes from one restrained accent color and a serif/mono contrast in the type, not from decoration. A full dark theme exists (`[data-theme="dark"]`) as a disciplined token swap — same roles, same contrast relationships, inverted lightness — never a second, separately-art-directed look.

**Key Characteristics:**
- Warm-paper neutral base with exactly one loud accent color (Cobalt Focus), used sparingly.
- Editorial serif reserved for display headlines only; every other piece of text is small, sans-serif, and dense.
- Mono, uppercase, wide-tracked type marks anything machine-scoped: issue keys, counts, timestamps, section overlines.
- Flat by default — hairline borders separate surfaces; a single soft shadow token appears only on floating overlays.
- No icon library. Every glyph (the compass mark, the blinking status dot, the Microsoft tile) is hand-drawn from primitive shapes.

## Colors

The palette is warm-neutral paper with one saturated accent; every other hue (indigo, green, amber, violet, danger) is a muted, desaturated "ledger stamp" reserved for status and role signaling, always paired with its own `-soft` tint for backgrounds.

### Primary
- **Cobalt Focus** (`#2f6fea`): the one interactive/brand color in the system — primary buttons, links, active accents, the logo mark. Used sparingly; its rarity is the point.

### Secondary
- **Deep Navy** (`#1b3a6b`): the brand-mark surface color — the login hero panel background and the workspace-switcher swatch. Reads as Cobalt Focus's darker, quieter sibling, not a separate brand color.

### Tertiary
- **Ledger Green** (`#1c7a54`), **Ledger Amber** (`#9a6410`), **Ledger Violet** (`#584a86`): muted status/role hues used only in badges, avatar initials, and small tags — each always paired with its `-soft` tint (`#dff0e8`, `#faedd4`, `#ebe7f6`) as the badge background.
- **Ledger Danger** (`#c9432a`, soft `#fae9e4`): destructive actions and error states — deliberately split from Cobalt Focus (they used to share a value) so rebranding the accent never makes errors read as less alarming.

### Neutral
- **Warm Paper** (`#f6f4ef`): page background.
- **Surface White** (`#ffffff`) / **Surface Cream** (`#fbf9f5`) / **Surface Tan** (`#efece4`): three ascending surface steps — card/panel background, a slightly warmer secondary surface (sidebar), and a tertiary hover/neutral-badge surface.
- **Ink Black** (`#191a1d`): primary text.
- **Ink Gray** (`#5b5d63`) / **Ink Mist** (`#8f9198`): secondary and tertiary text — subtext and placeholders/muted metadata.
- **Hairline** (`#e4e0d8`) / **Hairline Deep** (`#d3cec3`): default border and a stronger border for hover/dividers.

### Dark theme
`[data-theme="dark"]` swaps every token above 1:1 to a cool, low-chroma dark set (`--bg: #101115`, `--surface: #191b20` → `#282c34`, `--text: #eceef2` → `#70757e`, `--accent: #6c9bff`, `--indigo: #9fb8f0`, `--danger: #ff7a55`, etc.) — same roles, same relative contrast, never independently art-directed.

### Named Rules
**The One Loud Color Rule.** Cobalt Focus is the only saturated, attention-getting color in the system. Every other hue (indigo, green, amber, violet, danger) is muted and only ever appears in small doses — badges, avatar initials, status dots — never as a large fill.

**The Danger Independence Rule.** Danger/destructive red must never be derived from or share a value with the brand accent again — they were split apart deliberately so a rebrand of one can't accidentally soften the other.

## Typography

**Display Font:** Instrument Serif (fallback Georgia, serif)
**Body Font:** Instrument Sans (fallback ui-sans-serif, system-ui, sans-serif)
**Label/Mono Font:** JetBrains Mono

**Character:** A calm sans-serif carries essentially the entire interface at small, dense sizes; the serif appears only for the rare large headline, at normal (not bold) weight with tight tracking, so it reads editorial rather than decorative. Mono is the tell that a value is data, not prose.

### Hierarchy
- **Display** (400, 40–52px, line-height 1.04, tight tracking): hero/landing headlines only (login hero, empty-state welcome) — Instrument Serif, never used for UI chrome.
- **Title** (600, 20–25px, tight tracking): page/section headings (e.g. "Sign in to Kompast").
- **Headline** (600, 15–17px): component and card headers, the wordmark, sidebar section titles.
- **Body** (400–500, 12.5–15px, relaxed leading for paragraphs): the overwhelming majority of UI text — buttons, inputs, table cells, descriptions.
- **Label** (500, 9.5–11.5px, wide tracking (~0.1em) + uppercase for overlines): badges, avatar initials, section overlines, and — in mono — issue keys, counts, timestamps, story points.

### Named Rules
**The Serif-Is-Rare Rule.** Instrument Serif appears only on true display headlines (login hero, empty-state welcome). If a component needs emphasis anywhere else, reach for sans-serif weight/size, never the serif.

**The Mono Metadata Rule.** Any value that is machine-scoped rather than authored prose — an issue key, a count, a timestamp, story points, a section overline — renders in JetBrains Mono, small, and usually in Ink Mist. This is how the system visually distinguishes "data" from "content" without adding an icon or a label.

## Layout

Density is tight and information-forward: most interactive elements sit inside 6–14px of padding, gaps between items run 2–10px, and text sizes stay mostly under 15px so more of the workspace (tables, kanban columns, doc trees) is visible at once. The primary app shell is a fixed collapsible sidebar (`SidebarShell`) — 62px collapsed ("rail" mode, the default) or 252px expanded ("tree" mode) — animated only on user-triggered toggle, never on initial mount, next to a fluid main content column. Floating panels (search, notifications, version history, locale switcher) are fixed-width (180–320px) absolutely-positioned dropdowns anchored below their trigger.

## Elevation & Depth

Flat by default. Surfaces at rest are separated by a 1px hairline border (`--border`/`--border-2`), not a shadow — cards, sidebars, and input fields carry no shadow at rest. The single shadow token (`--shadow`, exposed as the `shadow-kp` utility) is reserved for floating/overlay surfaces only: dropdown menus, popovers, the notification panel, version history, and the rare hover-lift on an interactive row. It is soft and low-contrast even there — never a hard drop shadow.

### Shadow Vocabulary
- **Ambient overlay** (`box-shadow: 0 1px 2px rgba(25,26,29,.06), 0 8px 20px -10px rgba(25,26,29,.16)`, dark: `0 1px 2px rgba(0,0,0,.5), 0 10px 28px -12px rgba(0,0,0,.7)`): the only shadow in the system. Used exclusively on elements that float above the page (dropdowns, popovers, panels), never on elements resting in the normal document flow.

### Named Rules
**The Overlay-Only Shadow Rule.** If an element sits in normal document flow, it gets a border, not a shadow. Shadow is reserved for anything that visually floats above the page.

## Shapes

Radius is fine-tuned to custom pixel values rather than a generic Tailwind default scale, and the value scales with the element's role: **7px** for the primary interactive controls (buttons, inputs, search fields — the most-repeated shape in the system), **9–10px** for compact floating surfaces and small icon tiles (the logo mark, dropdown panels), **12px** for cards and larger containers, and **full/pill** for anything representing an identity or status (avatars, badges). A handful of components still fall back to Tailwind's stock 6px/8px radii rather than the custom scale — treat that as drift to correct, not a second intentional scale.

## Components

### Buttons
- **Shape:** 7px radius (`rounded-[7px]`), the system's signature control radius.
- **Primary:** Cobalt Focus background, white semibold text, `hover:opacity-90` (no color shift, just an opacity dip).
- **Dark:** Ink Black background, Warm Paper text — used for the single highest-emphasis action per screen (e.g. "Continue with Microsoft").
- **Outline:** white/surface background, hairline border, Ink Gray text, hover fills to the tertiary surface.
- **Ghost:** no border or fill, Ink Gray text, hover fills to the tertiary surface.
- All variants: 13px medium text, `disabled:opacity-50 disabled:pointer-events-none`, transition on opacity only — never a size or position shift.

### Badges / Chips
- **Style:** full-pill radius, 10.5px semibold text, no border — color comes entirely from a `{hue}-soft` background + `{hue}` text pairing (six tones: neutral, accent, indigo, green, amber, violet).
- **Avatars** reuse the exact same tone system as circles instead of pills, with 9.5px bold initials — visually the same "identity chip" language as badges.

### Cards / Containers
- **Corner Style:** 12px radius (`rounded-xl`).
- **Background:** Surface White on Warm Paper.
- **Shadow Strategy:** none at rest — a hairline `--border` is the only separation (see Elevation & Depth).
- **Border:** 1px, `--border`.

### Inputs / Fields
- **Style:** borderless, transparent background by default (the parent `SearchField` wrapper supplies the 7px-radius bordered container); 12.5px text, placeholder in Ink Mist.
- **Focus:** no visible focus ring on the bare `Input` — focus treatment lives on the wrapping container, not the field itself.

### Navigation (Tabs)
- **Style:** underline tabs — a 2px bottom border, transparent when inactive and Ink Black when active; 13px text, medium weight inactive / semibold active, Ink Gray → Ink Black on hover. No pill or background-fill tab style anywhere in the system.

### Sidebar Shell (signature component)
The one structural chrome component: a fixed-width `<aside>` that is either 62px (icon-only "rail," the default) or 252px ("tree," expanded), with the width transition gated behind mount so the very first render never animates — only a user-triggered toggle slides. Collapse state persists to `localStorage`. This rail/tree split, not a hamburger menu or an always-expanded sidebar, is how Kompast handles navigation density.

### Compass Mark (signature component)
The brand glyph: a `30×30px`, 9px-radius Cobalt Focus square containing a small (`8×8px`) white square rotated 45° (a diamond), centered. This exact construction — never a bitmap logo file in-app — is the only recurring "icon" the system treats as sacred; every other glyph is drawn ad hoc from the same primitive-shapes philosophy (e.g. the blinking status dot, the four-tile Microsoft glyph) but only the compass mark is brand-load-bearing.

## Do's and Don'ts

### Do:
- **Do** keep Cobalt Focus rare — one primary action per view, not a wash of blue across the screen.
- **Do** render machine-scoped values (keys, counts, timestamps, points) in JetBrains Mono per the Mono Metadata Rule, even in a brand-new component.
- **Do** use a border for anything at rest and reserve `shadow-kp` strictly for floating overlays.
- **Do** reuse the existing custom radius scale (7 / 9 / 10 / 12px / full) instead of Tailwind's stock `rounded-md`/`rounded-lg` defaults.
- **Do** treat light/dark as one token swap — never author dark mode as a separately art-directed theme.

### Don't:
- **Don't** use Instrument Serif outside true display headlines — it must stay rare to keep its impact.
- **Don't** add a shadow to anything resting in normal document flow (cards, sidebars, table rows) — that's the Overlay-Only Shadow Rule.
- **Don't** pull in an icon library (Lucide, Heroicons, etc.) — every glyph in this system is hand-drawn from primitive shapes; an imported icon set would visually clash immediately.
- **Don't** let the destructive/danger color drift back toward sharing a value with the brand accent.
