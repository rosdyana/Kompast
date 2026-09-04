import { describe, expect, it } from "vitest";
import { render } from "@react-email/render";
import { createMailer, NotificationEmail } from "../index";

describe("packages/mail", () => {
  it("renders NotificationEmail to HTML containing the title, body, and action link", async () => {
    const html = await render(
      NotificationEmail({ title: "You were assigned KPT-1", body: "Please take a look", actionUrl: "https://kompast.example/issues/KPT-1", actionLabel: "View issue" }),
    );
    expect(html).toContain("You were assigned KPT-1");
    expect(html).toContain("Please take a look");
    expect(html).toContain("https://kompast.example/issues/KPT-1");
    expect(html).toContain("View issue");
  });

  it("renders a plain-text fallback with no HTML tags", async () => {
    const text = await render(NotificationEmail({ title: "Plain text check", actionUrl: "https://kompast.example/x", actionLabel: "Go" }), { plainText: true });
    expect(text).toContain("Plain text check");
    expect(text).not.toContain("<html");
  });

  it("createMailer throws for brevo/resend with no API key configured", () => {
    expect(() => createMailer({ driver: "brevo", from: "a@example.com", apiKey: null, smtpUrl: null })).toThrow(/api key/i);
    expect(() => createMailer({ driver: "resend", from: "a@example.com", apiKey: null, smtpUrl: null })).toThrow(/api key/i);
  });

  it("createMailer throws for smtp with no connection URL configured", () => {
    expect(() => createMailer({ driver: "smtp", from: "a@example.com", apiKey: null, smtpUrl: null })).toThrow(/smtp/i);
  });

  it("createMailer succeeds building an smtp driver given a connection URL (no network call made)", () => {
    expect(() => createMailer({ driver: "smtp", from: "a@example.com", apiKey: null, smtpUrl: "smtp://localhost:1025" })).not.toThrow();
  });
});
