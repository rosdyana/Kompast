import "i18next";
import type enCommon from "./locales/en/common.json";
import type enNav from "./locales/en/nav.json";
import type enHome from "./locales/en/home.json";
import type enSearch from "./locales/en/search.json";
import type enNotifications from "./locales/en/notifications.json";
import type enAuth from "./locales/en/auth.json";
import type enShare from "./locales/en/share.json";
import type enTokens from "./locales/en/tokens.json";
import type enAsk from "./locales/en/ask.json";
import type enProjects from "./locales/en/projects.json";
import type enTeams from "./locales/en/teams.json";
import type enSettings from "./locales/en/settings.json";
import type enDocs from "./locales/en/docs.json";
import type enBoard from "./locales/en/board.json";
import type enIssue from "./locales/en/issue.json";

declare module "i18next" {
  interface CustomTypeOptions {
    defaultNS: "common";
    resources: {
      common: typeof enCommon;
      nav: typeof enNav;
      home: typeof enHome;
      search: typeof enSearch;
      notifications: typeof enNotifications;
      auth: typeof enAuth;
      share: typeof enShare;
      tokens: typeof enTokens;
      ask: typeof enAsk;
      projects: typeof enProjects;
      teams: typeof enTeams;
      settings: typeof enSettings;
      docs: typeof enDocs;
      board: typeof enBoard;
      issue: typeof enIssue;
    };
  }
}
