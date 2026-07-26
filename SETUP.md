# Operator setup checklist — what you personally need to provide

Everything else (code, secret generation, D1 creation, deploys) is handled in the repo;
the items here need you because they involve accounts, payment identity, or decisions
only the operator can make. Technical detail lives in [SPEC.md](SPEC.md) §3; the work
queue is [TODO.md](TODO.md).

Legend: ✅ done · ⏳ waiting on you · 💤 not needed yet.

---

## 1. ✅ Cloudflare account

Account `cityshield.varna@gmail.com`, `wrangler login` completed 2026-07-19. D1 lives in
`weur`; the Worker is deployed at `https://cityshield.cityshield-varna.workers.dev`, with
`JWT_KEY`, `INGEST_API_KEY` and `ONESIGNAL_API_KEY` stored as Worker secrets.

Note for anyone re-provisioning: Workers AI **does not work on throwaway preview
accounts** — a real account is genuinely required, but the free plan is enough for
everything specced.

## 2. Push notifications — OneSignal app

Delivery goes through OneSignal rather than FCM directly: FCM has no multicast endpoint,
so a broadcast cost one Worker subrequest *per device* and had to chain self-invocations
to get past the 50-subrequest ceiling. OneSignal takes up to 2,000 users per call and
fans out on its own infrastructure ([SPEC.md](SPEC.md) §1.6).

Android still rides on FCM underneath, so the Firebase project stays — it just moves
behind OneSignal instead of being called by us.

✅ **Credentials received and installed** (2026-07-21): App ID committed to
`wrangler.jsonc` and inlined in the APK build (both public), REST key uploaded as a
Worker secret and mirrored in local `.dev.vars`.

⏳ **Two things still on you:**

- **Confirm the Android settings.** OneSignal dashboard → Settings → Push & In-App →
  Google Android: the Firebase service-account JSON must be uploaded, and the **Android
  package name** must match the app's `applicationId` (`com.cityshield.fcmtest` today —
  see `PACKAGE_NAME` in [frontend/scripts/build.sh](frontend/scripts/build.sh)). Nothing
  in the code can detect a mismatch: devices subscribe successfully and then silently
  receive nothing.
- **Rotate the REST key.** It was pasted into a chat transcript. It can only send pushes,
  not read subscriber data, so the risk is spam rather than a breach — but regenerating
  it and re-running `wrangler secret put ONESIGNAL_API_KEY` takes about a minute.

## 3. ⏳ CI auto-deploys — one API token, one GitHub secret

- Cloudflare dashboard → My Profile → API Tokens → create from the **"Edit Cloudflare
  Workers"** template, scoped to your account.
- Add it to the GitHub repo as the secret `CLOUDFLARE_API_TOKEN`.

Whether this was ever done is unverified (there is no `gh` CLI on the dev machine to
check). Until it is, the `deploy` job in CI is a no-op and deploys happen by hand with
`npx wrangler deploy`.

## 4. ✅ Privacy policy — decided

- Controller contact published in the policy: **cityshield.varna@gmail.com**
  (confirmed 2026-07-21).
- Policy languages: Bulgarian + English, both served at `/privacy`.

## 5. ⏳ Email verification & password reset — decision parked

Both flows are built and tested, but **delivery is mocked**: the Worker composes each
message and logs its link instead of sending it ([backend/src/core/mailer.ts](backend/src/core/mailer.ts)).
Nobody can receive a verification or reset link until a provider is wired up.

Parked because the provider choice follows a prior decision — **whether to register a
domain**:

- Sending as `cityshield.varna@gmail.com` through any third party fails SPF/DKIM
  alignment (gmail.com does not authorize them), so those links land in spam often enough
  to matter for a password reset. A domain is the only real fix.
- **With a domain** (~$10/yr at Cloudflare Registrar, which would also give the API and
  the Play listing a real URL): Resend is the better fit — transactional-only, no
  free-tier branding.
- **Without one**: Brevo can send from a validated single address, accepting the spam
  risk and its free-tier branding.

Once decided, the work is one function (`deliver` in `mailer.ts`) plus paperwork: accept
the provider's DPA, add it to the processor list in `/privacy` and COMPLIANCE.md §5, and
widen the Play Data Safety purpose for email to include Account management.

## 6. ⏳ Play Store release — the things only you can hold

- **Google Play developer account** (one-time $25). Needed before anything can be
  published; the identity/address verification Google now requires takes days, not
  minutes, so start it early if a release date matters.
- **Decide the real package name.** The app still builds as `com.cityshield.fcmtest`, a
  test package. It is permanent once published, and changing it means re-registering the
  package in OneSignal too — so decide before the first upload, not after.
- **A release signing keystore.** Release APKs are currently signed with the *debug*
  keystore, which Play rejects. Whoever creates the real keystore must keep it (and its
  passwords) safe and backed up: losing it means never being able to update the app under
  that listing again. Uninstall any debug-signed build before installing a properly
  signed one — the signatures differ.
- **Store listing assets**: icon, feature graphic, screenshots, description, and the
  privacy-policy URL (`https://cityshield.cityshield-varna.workers.dev/privacy`, or the
  custom-domain equivalent if §5 leads to registering one).

## 7. ⏳ Processor paperwork (before the release)

Tracked with the reasoning in [COMPLIANCE.md](COMPLIANCE.md) §5; all are free and
self-service:

- Accept the **Cloudflare DPA** and download a copy.
- Accept the **OneSignal DPA**, and record which transfer mechanism applies (DPF or SCCs).
- Accept **Google's Data Processing Terms** in the Firebase console (FCM is still the
  Android delivery channel beneath OneSignal).
- Submit the **Play Data Safety form** using the filled-in answers in COMPLIANCE.md §1.

## 8. 💤 Not needed from you

- `JWT_KEY`, `INGEST_API_KEY` — generated with `openssl rand` and stored as Worker secrets.
- Custom domain — optional (~$10/yr via Cloudflare Registrar); `*.workers.dev` is fine for
  launch. It only becomes a prerequisite if §5 goes the Resend route.
- AI Gateway ("cityshield", free, for AI request logs) — nice for debugging, not urgent.
- No other accounts: Nominatim and Overpass need no registration — we just follow their
  usage policies, which the code is built to respect ([SPEC.md](SPEC.md) §2.6).
