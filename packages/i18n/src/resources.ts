import enCommon from "./locales/en/common.json";
import enNav from "./locales/en/nav.json";
import enHome from "./locales/en/home.json";
import idCommon from "./locales/id/common.json";
import idNav from "./locales/id/nav.json";
import idHome from "./locales/id/home.json";
import zhHantCommon from "./locales/zh-Hant/common.json";
import zhHantNav from "./locales/zh-Hant/nav.json";
import zhHantHome from "./locales/zh-Hant/home.json";

export const resources = {
  en: { common: enCommon, nav: enNav, home: enHome },
  id: { common: idCommon, nav: idNav, home: idHome },
  "zh-Hant": { common: zhHantCommon, nav: zhHantNav, home: zhHantHome },
} as const;
