import { createServerFn } from "@tanstack/react-start";
import { loadEnv } from "@kompast/env";
import { getDevAdminConfig } from "../auth";

/**
 * Deliberately unauthenticated, like getSetupStatusFn — the login page needs
 * this before any session exists. Only ever returns true in local dev with
 * ENABLE_DEV_LOGIN explicitly set (see getDevAdminConfig).
 */
export const getDevLoginStatusFn = createServerFn({ method: "GET" }).handler(() => ({
  enabled: getDevAdminConfig(loadEnv()).enabled,
}));
