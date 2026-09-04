import type { ReactElement } from "react";

export interface SendEmailInput {
  to: string;
  subject: string;
  react: ReactElement;
  replyTo?: string;
  tags?: string[];
}

export interface SendEmailResult {
  providerMessageId: string;
}

export interface MailDriver {
  send(input: { to: string; from: string; subject: string; html: string; text: string; replyTo?: string; tags?: string[] }): Promise<SendEmailResult>;
}

/**
 * Decrypted mail credentials — the shape packages/core's
 * getMailCredentials() returns. packages/mail deliberately doesn't depend
 * on @kompast/core/@kompast/db itself (it only knows how to send given
 * already-resolved config), so the config-resolution boundary stays in one
 * place and the driver choice can change at runtime (admin edits it at
 * /settings) without this package caring how it got fetched.
 */
export interface MailCredentials {
  driver: "brevo" | "resend" | "smtp";
  from: string;
  apiKey: string | null;
  smtpUrl: string | null;
}
