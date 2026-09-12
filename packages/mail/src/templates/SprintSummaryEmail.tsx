// Explicit import (not just relied-upon automatic JSX runtime): tsx's
// on-the-fly esbuild transform for apps/worker's dev/CJS execution doesn't
// pick up this package's own tsconfig.json ("jsx": "react-jsx") and falls
// back to the classic transform (`React.createElement`), which needs
// `React` in scope — same gotcha documented in NotificationEmail.tsx.
import * as React from "react";
import { Body, Container, Head, Heading, Html, Preview, Text } from "@react-email/components";

export interface SprintSummaryEmailProps {
  subject: string;
  body: string;
}

/** The email a Sprint Review "Send by Email" click renders through (see packages/core/src/email.ts's sendSprintSummaryEmail). */
export function SprintSummaryEmail({ subject, body }: SprintSummaryEmailProps) {
  return (
    <Html>
      <Head />
      <Preview>{subject}</Preview>
      <Body style={{ fontFamily: "sans-serif", background: "#f5f5f5", padding: "24px" }}>
        <Container style={{ background: "#ffffff", borderRadius: "8px", padding: "24px", maxWidth: "560px" }}>
          <Heading as="h2" style={{ fontSize: "16px" }}>
            {subject}
          </Heading>
          {body.split("\n").map((line, i) => (
            <Text key={i} style={{ color: "#444", margin: line ? "0 0 4px" : "0 0 12px" }}>
              {line || " "}
            </Text>
          ))}
        </Container>
      </Body>
    </Html>
  );
}
