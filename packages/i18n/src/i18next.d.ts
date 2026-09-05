import "i18next";
import type enCommon from "./locales/en/common.json";
import type enNav from "./locales/en/nav.json";
import type enHome from "./locales/en/home.json";

declare module "i18next" {
  interface CustomTypeOptions {
    defaultNS: "common";
    resources: { common: typeof enCommon; nav: typeof enNav; home: typeof enHome };
  }
}
