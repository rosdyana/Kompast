import type { MailDriver } from "../types";

/** https://developers.brevo.com/reference/sendtransacemail */
export function createBrevoDriver(apiKey: string, from: string): MailDriver {
  return {
    async send(input) {
      const res = await fetch("https://api.brevo.com/v3/smtp/email", {
        method: "POST",
        headers: { "api-key": apiKey, "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({
          sender: { email: from },
          to: [{ email: input.to }],
          subject: input.subject,
          htmlContent: input.html,
          textContent: input.text,
          replyTo: input.replyTo ? { email: input.replyTo } : undefined,
          tags: input.tags,
        }),
      });
      if (!res.ok) throw new Error(`Brevo send failed (${res.status}): ${await res.text()}`);
      const body = (await res.json()) as { messageId: string };
      return { providerMessageId: body.messageId };
    },
  };
}
