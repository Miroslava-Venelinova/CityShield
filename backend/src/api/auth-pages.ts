// HTML for the pages a mailed link lands on.
//
// These are web pages rather than deep links into the app on purpose: the link
// is opened from whatever mail client the user has, on any device, possibly one
// without the app installed. A browser page works everywhere, and the password
// reset needs a form anyway.
//
// Kept out of auth.ts so the route file stays a readable list of endpoints.

const SHELL_CSS = `
  body { font-family: system-ui, sans-serif; max-width: 30rem; margin: 3rem auto; padding: 0 1.25rem; line-height: 1.6; color: #222; }
  h1 { font-size: 1.35rem; }
  .en { color: #555; }
  .msg { border-left: 4px solid #1e5fa8; background: #f4f8fc; padding: 0.75rem 1rem; border-radius: 4px; }
  .bad { border-left-color: #b3261e; background: #fdf4f3; }
  label { display: block; margin-top: 1.25rem; font-size: 0.95rem; }
  input[type=password] { width: 100%; padding: 0.6rem; font-size: 1rem; border: 1px solid #bbb; border-radius: 6px; box-sizing: border-box; }
  button { margin-top: 1.5rem; background: #1e5fa8; color: #fff; border: 0; padding: 0.7rem 1.3rem; font-size: 1rem; border-radius: 6px; cursor: pointer; }
  .hint { font-size: 0.85rem; color: #666; }
`;

function shell(title: string, body: string): string {
  return `<!doctype html>
<html lang="bg">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title><style>${SHELL_CSS}</style></head>
<body>${body}</body></html>`;
}

/** Attribute-safe: the only interpolated value is a token we minted ourselves. */
function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function resultPage(
  bg: string, en: string, ok: boolean, extraBg = "", extraEn = "",
): string {
  const cls = ok ? "msg" : "msg bad";
  return shell("CityShield", `
<h1>CityShield</h1>
<p class="${cls}">${bg}${extraBg ? `<br><span class="hint">${extraBg}</span>` : ""}</p>
<p class="${cls} en">${en}${extraEn ? `<br><span class="hint">${extraEn}</span>` : ""}</p>`);
}

/**
 * The reset form. The token rides in a hidden field so redemption happens on
 * POST — a mail scanner that prefetches the link renders this page and burns
 * nothing.
 */
export function resetFormPage(token: string, errorBg = "", errorEn = ""): string {
  const error = errorBg
    ? `<p class="msg bad">${errorBg}</p><p class="msg bad en">${errorEn}</p>`
    : "";
  return shell("CityShield — нова парола", `
<h1>Нова парола / New password</h1>
${error}
<form method="post" action="/api/auth/password/reset">
  <input type="hidden" name="token" value="${escapeAttr(token)}">
  <label for="password">Нова парола / New password</label>
  <input id="password" name="password" type="password" minlength="8" maxlength="50" required autocomplete="new-password">
  <label for="confirm">Повторете паролата / Repeat password</label>
  <input id="confirm" name="confirm" type="password" minlength="8" maxlength="50" required autocomplete="new-password">
  <p class="hint">Поне 8 знака. / At least 8 characters.</p>
  <button type="submit">Запази / Save</button>
</form>`);
}
