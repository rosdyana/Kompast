import { ErrorPage } from "./ErrorPage";

/**
 * Shown when a project/issue/page loader throws notFound(). Team-scoped
 * RLS makes "belongs to a team you're not in" indistinguishable from
 * "doesn't exist" at the database level, and the copy deliberately keeps
 * it that way — telling someone a hidden thing exists would leak exactly
 * what the RLS hides.
 */
export function NoAccessState() {
  return <ErrorPage variant="noAccess" />;
}
