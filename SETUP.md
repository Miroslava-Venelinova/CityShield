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

## 4. Phase 4 (privacy policy) — two decisions from you

- **Controller identity + contact email** to publish in the privacy policy (GDPR requires a real
  contact; a dedicated address like privacy@… or a personal one — your call).
- Confirm the policy languages (plan says Bulgarian + English).

## Not needed from you

- `JWT_KEY`, `INGEST_API_KEY` — I generate these with `openssl rand` and store them as Worker secrets.
- Custom domain — optional later (~$10/yr via Cloudflare Registrar); `*.workers.dev` is fine for launch.
- AI Gateway ("cityshield", free, for AI request logs) — I can create it from the dashboard-less
  API, or you click AI → AI Gateway → Create in the dashboard; either works, not urgent.
- No other accounts: Nominatim/Overpass need no registration (we just follow their usage policies).
