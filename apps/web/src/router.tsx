import { createRouter as createTanStackRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";
import { ErrorPage } from "@/components/shared/ErrorPage";

export function getRouter() {
  return createTanStackRouter({
    routeTree,
    scrollRestoration: true,
    defaultPreload: "intent",
    // Routes without their own boundary. Child-route errors render inside
    // _app's Outlet, so the sidebar stays usable.
    defaultErrorComponent: ({ error, reset }) => <ErrorPage variant="serverError" error={error} reset={reset} />,
    defaultNotFoundComponent: () => <ErrorPage variant="notFound" />,
  });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
