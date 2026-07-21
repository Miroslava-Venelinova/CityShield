# Operator setup checklist — what you personally need to provide

Everything else (code, secrets generation, D1 creation, deploys) I can do; these items need
you because they involve accounts, payment identity, or decisions only the operator can make.
Details in [PLAN.MD](PLAN.MD) §3; current status in [TODO.md](TODO.md).

## 1. ✅ Done — Cloudflare account

Account `cityshield.varna@gmail.com`, `wrangler login` completed 2026-07-19. D1 lives in
`weur`; the Worker is deployed at `https://cityshield.cityshield-varna.workers.dev`.

Note for anyone re-provisioning: Workers AI **does not work on throwaway preview accounts** —
a real account is genuinely required, but the free plan is enough for everything in the plan.

## 2. Push notifications — OneSignal app

Delivery goes through OneSignal rather than FCM directly: FCM has no multicast
endpoint, so a broadcast cost one Worker subrequest *per device* and had to chain
self-invocations to get past the 50-subrequest ceiling. OneSignal takes up to 2,000
users per call and fans out on its own infrastructure.

Android still rides on FCM underneath, so the Firebase project stays — it just moves
behind OneSignal instead of being called by us.

In the OneSignal dashboard:

- Settings → Push & In-App → **Google Android**: upload the Firebase service-account
  JSON and set the **Android package name**. It must match the app's `applicationId`
  (`com.cityshield.fcmtest` today — see `PACKAGE_NAME` in
  [frontend/scripts/build.sh](frontend/scripts/build.sh)). A mismatch means devices
  subscribe successfully and then never receive anything.
- Settings → Keys & IDs: the **App ID** goes in `wrangler.jsonc` vars and in the app's
  `ONESIGNAL_APP_ID` build env var (both public). The **REST API Key** is the secret —
  store it with `npx wrangler secret put ONESIGNAL_API_KEY`; it never touches git.

**Status (2026-07-21):** both credentials received and installed — App ID committed to
`wrangler.jsonc`, REST key uploaded as a Worker secret. Two things still on you:

- **Confirm the Android settings above** (service-account JSON uploaded, package name
  matching `com.cityshield.fcmtest`). Nothing in the code can detect a mismatch: devices
  subscribe successfully and then silently receive nothing.
- **Consider rotating the REST key.** It was pasted into a chat transcript. It can only
  send pushes — it cannot read subscriber data — so the risk is spam, not a breach, but
  regenerating it and re-running `wrangler secret put` takes about a minute.

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
