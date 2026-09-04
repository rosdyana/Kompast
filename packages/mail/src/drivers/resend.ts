import type { MailDriver } from "../types";

/** https://resend.com/docs/api-reference/emails/send-email */
export function createResendDriver(apiKey: string, from: string): MailDriver {
  return {
    async send(input) {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          from,
          to: [input.to],
          subject: input.subject,
          html: input.html,
          text: input.text,
          reply_to: input.replyTo,
          tags: input.tags?.map((name) => ({ name, value: "true" })),
        }),
      });
      if (!res.ok) throw new Error(`Resend send failed (${res.status}): ${await res.text()}`);
      const body = (await res.json()) as { id: string };
      return { providerMessageId: body.id };
    },
  };
}
