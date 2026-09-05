import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * Members management moved into /settings's default "Anggota" tab, folded
 * in alongside Teams/Roles & Permissions/Integrations as one coherent
 * workspace-settings surface. This route stays only as a redirect so old
 * bookmarks/links keep working.
 */
export const Route = createFileRoute("/_app/members")({
  beforeLoad: () => {
    throw redirect({ to: "/settings", search: { tab: "members" } });
  },
});
