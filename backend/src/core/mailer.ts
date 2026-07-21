// Outgoing mail for verification and password-reset links.
//
// ⚠️ MOCK — nothing is delivered. Messages are composed for real and then
// logged (and kept in a tiny in-memory outbox) instead of being handed to a
// provider. Every flow that depends on mail therefore works end-to-end in dev
// and in tests, but no user can receive a link in production.
//
// Why it stops here: Workers cannot open SMTP sockets, so delivery needs a
// third-party HTTP API, and picking one is blocked on a decision we have not
// made — see TODO.md "Phase 4b". The short version: sending as an @gmail.com
// address through any provider fails DMARC alignment and lands in spam, so the
// real fix is a domain, and the provider choice follows from that.
//
// To make it real: implement `deliver` against the chosen provider, add its
// credentials to Env, add it to the processor lists in api/privacy.ts and
// COMPLIANCE.md, and delete this notice.

import type { Env } from "../env";

export interface Mail {
  to: string;
  subject: string;
  intro: { bg: string; en: string };
  action: { bg: string; en: string };
  url: string;
  expiry: { bg: string; en: string };
}

/**
 * What the mock "sent", newest last. Exists so tests can follow a link the way
 * a user would, rather than reaching around the flow to mint their own token.
 *
 * Per-isolate and capped: this is a debugging aid, not a store. It holds
 * recipient addresses, so it must not outlive the mock.
 */
const OUTBOX_LIMIT = 10;
const outbox: Mail[] = [];

export function sentMail(): readonly Mail[] {
  return outbox;
}

export function clearSentMail(): void {
  outbox.length = 0;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * Bilingual body, Bulgarian first — the audience is Varna residents, and the
 * app itself defaults to Bulgarian.
 *
 * Kept complete even though nothing sends it: composing the real message now is
 * what makes swapping in a provider a one-function change later.
 */
export function render(mail: Mail): { html: string; text: string } {
  const url = escapeHtml(mail.url);
  const html = `<!doctype html><html lang="bg"><body style="font-family:system-ui,sans-serif;line-height:1.6;color:#222;max-width:34rem;margin:0 auto;padding:1.5rem">
<h2 style="font-size:1.2rem">CityShield</h2>
<p>${escapeHtml(mail.intro.bg)}</p>
<p style="margin:1.5rem 0"><a href="${url}" style="background:#1e5fa8;color:#fff;padding:0.7rem 1.2rem;border-radius:6px;text-decoration:none;display:inline-block">${escapeHtml(mail.action.bg)}</a></p>
<p style="font-size:0.85rem;color:#666">${escapeHtml(mail.expiry.bg)}</p>
<hr style="border:none;border-top:1px solid #ddd;margin:1.5rem 0">
<p style="color:#444">${escapeHtml(mail.intro.en)}</p>
<p style="margin:1.5rem 0"><a href="${url}" style="background:#1e5fa8;color:#fff;padding:0.7rem 1.2rem;border-radius:6px;text-decoration:none;display:inline-block">${escapeHtml(mail.action.en)}</a></p>
<p style="font-size:0.85rem;color:#666">${escapeHtml(mail.expiry.en)}</p>
<p style="font-size:0.8rem;color:#888;word-break:break-all">${url}</p>
</body></html>`;

  const text = [
    mail.intro.bg, mail.url, mail.expiry.bg, "",
    mail.intro.en, mail.url, mail.expiry.en,
  ].join("\n");

  return { html, text };
}

/**
 * Pretend to send. Never throws — callers must stay unable to fail because of
 * mail, which is also true of whatever real implementation replaces this.
 *
 * `env` is unused for now and kept so adding provider credentials later does
 * not churn every call site.
 */
export async function sendMail(_env: Env, mail: Mail): Promise<void> {
  outbox.push(mail);
  if (outbox.length > OUTBOX_LIMIT) outbox.shift();
  // The link is the whole point of the log line: it is the only way to walk
  // these flows until delivery is real.
  console.warn(`[mail:MOCK] not delivering "${mail.subject}" to ${mail.to}. Link: ${mail.url}`);
}

export function verificationMail(to: string, url: string): Mail {
  return {
    to,
    subject: "CityShield — потвърдете имейла си / confirm your email",
    intro: {
      bg: "Потвърдете имейл адреса си, за да можете да възстановите паролата си, ако я забравите.",
      en: "Confirm your email address so you can recover your password if you forget it.",
    },
    action: { bg: "Потвърди имейла", en: "Confirm email" },
    expiry: {
      bg: "Връзката е валидна 24 часа. Ако не сте се регистрирали в CityShield, просто игнорирайте това съобщение.",
      en: "The link is valid for 24 hours. If you did not sign up for CityShield, just ignore this message.",
    },
    url,
  };
}

export function passwordResetMail(to: string, url: string): Mail {
  return {
    to,
    subject: "CityShield — нова парола / reset your password",
    intro: {
      bg: "Получихме заявка за нова парола за вашия профил в CityShield.",
      en: "We received a request to set a new password for your CityShield account.",
    },
    action: { bg: "Задай нова парола", en: "Set a new password" },
    expiry: {
      bg: "Връзката е валидна 1 час и може да се използва само веднъж. Ако не сте заявили това, паролата ви остава непроменена — не е нужно да правите нищо.",
      en: "The link is valid for 1 hour and works only once. If you did not request this, your password is unchanged and you need do nothing.",
    },
    url,
  };
}
