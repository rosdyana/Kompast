import nodemailer from "nodemailer";
import type { MailDriver } from "../types";

/** `smtpUrl` is a full connection string, e.g. `smtps://user:pass@smtp.example.com:465`. */
export function createSmtpDriver(smtpUrl: string, from: string): MailDriver {
  const transport = nodemailer.createTransport(smtpUrl);
  return {
    async send(input) {
      const info = await transport.sendMail({
        from,
        to: input.to,
        subject: input.subject,
        html: input.html,
        text: input.text,
        replyTo: input.replyTo,
      });
      return { providerMessageId: info.messageId };
    },
  };
}
