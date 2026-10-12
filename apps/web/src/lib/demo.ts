import type { Env } from "@kompast/env";
import type { SupportedLocale } from "@kompast/i18n";

/** Every demo persona's email ends with this — never a routable domain, so no invitation/notification email can reach a real inbox. */
export const DEMO_EMAIL_DOMAIN = "demo.kompast.local";

export type DemoPersonaRole = "superAdmin" | "teamAdmin" | "teamMember" | "workspaceOwner";

export interface DemoPersona {
  email: string;
  name: string;
  /** UI language the login switches to — the software team works in English, marketing in Traditional Chinese. */
  locale: SupportedLocale;
  role: DemoPersonaRole;
  /** Display-only team label for the login card; the seed script creates the real memberships. */
  team: string | null;
}

/**
 * The one list both scripts/seed-demo.ts (creates these accounts) and the
 * login page (offers them) read, so a persona can't be offered that the
 * seed never created, or vice versa.
 */
export const DEMO_PERSONAS: DemoPersona[] = [
  { email: `grace@${DEMO_EMAIL_DOMAIN}`, name: "Grace Lin", locale: "en", role: "superAdmin", team: null },
  { email: `daniel@${DEMO_EMAIL_DOMAIN}`, name: "Daniel Wu", locale: "en", role: "teamAdmin", team: "Software Development" },
  { email: `priya@${DEMO_EMAIL_DOMAIN}`, name: "Priya Natarajan", locale: "en", role: "teamMember", team: "Software Development" },
  { email: `joyce@${DEMO_EMAIL_DOMAIN}`, name: "陳怡君 Joyce Chen", locale: "zh-Hant", role: "teamAdmin", team: "Marketing 行銷" },
  { email: `kevin@${DEMO_EMAIL_DOMAIN}`, name: "林志明 Kevin Lin", locale: "zh-Hant", role: "teamMember", team: "Marketing 行銷" },
  { email: `oliver@${DEMO_EMAIL_DOMAIN}`, name: "Oliver Hsu", locale: "en", role: "workspaceOwner", team: null },
];

export interface DemoConfig {
  enabled: boolean;
  accessCode?: string;
}

/** Same shape/strictness as auth.ts's getDevAdminConfig: refuses to boot half-configured. */
export function getDemoConfig(env: Pick<Env, "DEMO_MODE" | "DEMO_ACCESS_CODE">): DemoConfig {
  const enabled = env.DEMO_MODE === "true";
  if (enabled && !env.DEMO_ACCESS_CODE) {
    throw new Error("DEMO_MODE is true but DEMO_ACCESS_CODE is not set. Refusing to boot with demo mode half-configured.");
  }
  return { enabled, accessCode: env.DEMO_ACCESS_CODE };
}
