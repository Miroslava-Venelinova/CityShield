# Operator setup checklist — what you personally need to provide

Everything else (code, secrets generation, D1 creation, deploys) I can do; these items need
you because they involve accounts, payment identity, or decisions only the operator can make.
Details in [PLAN.MD](PLAN.MD) §3; current status in [TODO.md](TODO.md).

## 1. Now — Cloudflare account (blocks the AI model eval, then Phase 1+ deploys)

- Sign up at dash.cloudflare.com — free plan, **no credit card needed**.
  Use a team-accessible email, not a personal one. Enable 2FA.
- Then run in a terminal: `npx wrangler login` (opens browser OAuth) from anywhere in the repo.
- That's it — tell me when it's done. It unblocks:
  - the Workers AI model eval (last open Phase 0 item, ~5 min, see [spikes/RESULTS.md](spikes/RESULTS.md)),
  - creating the D1 database (`--location=weur` for GDPR) and real Worker deploys.

Note: Workers AI **does not work on the throwaway preview accounts** I used for the spikes —
a real account is genuinely required, but the free plan is enough for everything in the plan.

## 2. Phase 2 (push notifications) — Firebase service account

- Keep the existing Firebase project.
- In Google Cloud console → IAM & Admin → Service Accounts: create a **new** service account
  with only the "Firebase Cloud Messaging API Admin" role (don't reuse the all-powerful default
  one), create a JSON key, and have the JSON file ready.
- I'll store it as the `FCM_SERVICE_ACCOUNT` secret via `wrangler secret put` (it never touches git).

## 3. Phase 4 (CI auto-deploys) — one API token + one GitHub secret

- Cloudflare dashboard → My Profile → API Tokens → create from the **"Edit Cloudflare Workers"**
  template, scoped to your account.
- Add it to the GitHub repo as secret `CLOUDFLARE_API_TOKEN`.

## 4. Phase 4 (privacy policy) — decided

- Controller contact published in the policy: **cityshield.varna@gmail.com** (confirmed 2026-07-21).
- Policy languages: Bulgarian + English, both served at `/privacy`.

## 5. Email verification & password reset — decision parked

Both flows are built and tested, but **delivery is mocked**: the Worker composes each
message and logs its link instead of sending it (`backend/src/core/mailer.ts`). Nobody
can receive a verification or reset link until a provider is wired up.

Parked because the provider choice follows a prior decision — whether to register a
domain:

- Sending as `cityshield.varna@gmail.com` through any third party fails SPF/DKIM
  alignment (gmail.com does not authorize them), so those links land in spam often
  enough to matter for a password reset. A domain is the only real fix.
- **With a domain** (~$10/yr at Cloudflare Registrar, which would also give the API and
  the Play listing a real URL): Resend is the better fit — transactional-only, no
  free-tier branding.
- **Without one**: Brevo can send from a validated single address, accepting the spam
  risk and its free-tier branding.

Nothing is needed from you until that call is made.

## Not needed from you

- `JWT_KEY`, `INGEST_API_KEY` — I generate these with `openssl rand` and store them as Worker secrets.
- Custom domain — optional later (~$10/yr via Cloudflare Registrar); `*.workers.dev` is fine for launch.
- AI Gateway ("cityshield", free, for AI request logs) — I can create it from the dashboard-less
  API, or you click AI → AI Gateway → Create in the dashboard; either works, not urgent.
- No other accounts: Nominatim/Overpass need no registration (we just follow their usage policies).
