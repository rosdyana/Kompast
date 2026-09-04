import { render } from "@react-email/render";
import { createBrevoDriver } from "./drivers/brevo";
import { createResendDriver } from "./drivers/resend";
import { createSmtpDriver } from "./drivers/smtp";
import type { MailCredentials, MailDriver, SendEmailInput, SendEmailResult } from "./types";

export type { MailCredentials, MailDriver, SendEmailInput, SendEmailResult } from "./types";
export { NotificationEmail } from "./templates/NotificationEmail";
export type { NotificationEmailProps } from "./templates/NotificationEmail";

function createDriver(creds: MailCredentials): MailDriver {
  if (creds.driver === "brevo") {
    if (!creds.apiKey) throw new Error("Brevo requires an API key");
    return createBrevoDriver(creds.apiKey, creds.from);
  }
  if (creds.driver === "resend") {
    if (!creds.apiKey) throw new Error("Resend requires an API key");
    return createResendDriver(creds.apiKey, creds.from);
  }
  if (!creds.smtpUrl) throw new Error("SMTP requires a connection URL");
  return createSmtpDriver(creds.smtpUrl, creds.from);
}

export interface Mailer {
  send(input: SendEmailInput): Promise<SendEmailResult>;
}

/**
 * `send({to, subject, react, replyTo, tags})` — a React Email component in,
 * rendered to HTML + a plain-text fallback, handed to whichever driver
 * `creds.driver` selects. Callers build a fresh mailer per send (or cache
 * one keyed by credentials) rather than a module-level singleton, since
 * credentials are admin-editable at runtime (/settings), not a boot-time
 * env var like packages/storage's driver choice.
 */
export function createMailer(creds: MailCredentials): Mailer {
  const driver = createDriver(creds);
  return {
    async send(input) {
      const [html, text] = await Promise.all([render(input.react), render(input.react, { plainText: true })]);
      return driver.send({ to: input.to, from: creds.from, subject: input.subject, html, text, replyTo: input.replyTo, tags: input.tags });
    },
  };
}
