import enCommon from "./locales/en/common.json";
import enNav from "./locales/en/nav.json";
import enHome from "./locales/en/home.json";
import enSearch from "./locales/en/search.json";
import enNotifications from "./locales/en/notifications.json";
import enAuth from "./locales/en/auth.json";
import enShare from "./locales/en/share.json";
import enTokens from "./locales/en/tokens.json";
import enAsk from "./locales/en/ask.json";
import enProjects from "./locales/en/projects.json";
import enTeams from "./locales/en/teams.json";
import enSettings from "./locales/en/settings.json";
import enDocs from "./locales/en/docs.json";
import enBoard from "./locales/en/board.json";
import enIssue from "./locales/en/issue.json";

import idCommon from "./locales/id/common.json";
import idNav from "./locales/id/nav.json";
import idHome from "./locales/id/home.json";
import idSearch from "./locales/id/search.json";
import idNotifications from "./locales/id/notifications.json";
import idAuth from "./locales/id/auth.json";
import idShare from "./locales/id/share.json";
import idTokens from "./locales/id/tokens.json";
import idAsk from "./locales/id/ask.json";
import idProjects from "./locales/id/projects.json";
import idTeams from "./locales/id/teams.json";
import idSettings from "./locales/id/settings.json";
import idDocs from "./locales/id/docs.json";
import idBoard from "./locales/id/board.json";
import idIssue from "./locales/id/issue.json";

import zhHantCommon from "./locales/zh-Hant/common.json";
import zhHantNav from "./locales/zh-Hant/nav.json";
import zhHantHome from "./locales/zh-Hant/home.json";
import zhHantSearch from "./locales/zh-Hant/search.json";
import zhHantNotifications from "./locales/zh-Hant/notifications.json";
import zhHantAuth from "./locales/zh-Hant/auth.json";
import zhHantShare from "./locales/zh-Hant/share.json";
import zhHantTokens from "./locales/zh-Hant/tokens.json";
import zhHantAsk from "./locales/zh-Hant/ask.json";
import zhHantProjects from "./locales/zh-Hant/projects.json";
import zhHantTeams from "./locales/zh-Hant/teams.json";
import zhHantSettings from "./locales/zh-Hant/settings.json";
import zhHantDocs from "./locales/zh-Hant/docs.json";
import zhHantBoard from "./locales/zh-Hant/board.json";
import zhHantIssue from "./locales/zh-Hant/issue.json";

export const resources = {
  en: {
    common: enCommon,
    nav: enNav,
    home: enHome,
    search: enSearch,
    notifications: enNotifications,
    auth: enAuth,
    share: enShare,
    tokens: enTokens,
    ask: enAsk,
    projects: enProjects,
    teams: enTeams,
    settings: enSettings,
    docs: enDocs,
    board: enBoard,
    issue: enIssue,
  },
  id: {
    common: idCommon,
    nav: idNav,
    home: idHome,
    search: idSearch,
    notifications: idNotifications,
    auth: idAuth,
    share: idShare,
    tokens: idTokens,
    ask: idAsk,
    projects: idProjects,
    teams: idTeams,
    settings: idSettings,
    docs: idDocs,
    board: idBoard,
    issue: idIssue,
  },
  "zh-Hant": {
    common: zhHantCommon,
    nav: zhHantNav,
    home: zhHantHome,
    search: zhHantSearch,
    notifications: zhHantNotifications,
    auth: zhHantAuth,
    share: zhHantShare,
    tokens: zhHantTokens,
    ask: zhHantAsk,
    projects: zhHantProjects,
    teams: zhHantTeams,
    settings: zhHantSettings,
    docs: zhHantDocs,
    board: zhHantBoard,
    issue: zhHantIssue,
  },
} as const;
