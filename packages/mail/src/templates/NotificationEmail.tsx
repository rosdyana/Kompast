// Explicit import (not just relied-upon automatic JSX runtime): tsx's
// on-the-fly esbuild transform for apps/worker's dev/CJS execution doesn't
// pick up this package's own tsconfig.json ("jsx": "react-jsx") and falls
// back to the classic transform (`React.createElement`), which needs
// `React` in scope — confirmed by a real ReferenceError, not assumed.
import * as React from "react";
import { Body, Container, Head, Heading, Html, Link, Preview, Text } from "@react-email/components";

export interface NotificationEmailProps {
  title: string;
  body?: string;
  actionUrl: string;
  actionLabel: string;
}

/** The one email every notify() call with an `email` payload renders through (see packages/core/src/notification.ts). */
export function NotificationEmail({ title, body, actionUrl, actionLabel }: NotificationEmailProps) {
  return (
    <Html>
      <Head />
      <Preview>{title}</Preview>
      <Body style={{ fontFamily: "sans-serif", background: "#f5f5f5", padding: "24px" }}>
        <Container style={{ background: "#ffffff", borderRadius: "8px", padding: "24px", maxWidth: "480px" }}>
          <Heading as="h2" style={{ fontSize: "16px" }}>
            {title}
          </Heading>
          {body && <Text style={{ color: "#444" }}>{body}</Text>}
          <Link href={actionUrl} style={{ color: "#5b5bd6" }}>
            {actionLabel} →
          </Link>
        </Container>
      </Body>
    </Html>
  );
}
