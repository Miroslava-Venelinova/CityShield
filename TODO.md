# CityShield — remaining work

The Cloudflare migration is finished: the Worker is code-complete, tested (346 tests
green) and deployed, and the app is built against OneSignal. What the system *does* is
specified in [SPEC.md](SPEC.md); this file is only what is still open.

**One thing gates almost everything else:** no device has ever been signed in against a
OneSignal build, so **OneSignal has zero subscribers** and no push has been proven
end to end. Start at §1.

Items marked 🧑 need the operator (accounts, payments, decisions) — see [SETUP.md](SETUP.md).

---

## 1. Prove push delivery on a real device

The APK built 2026-07-21 carries the Hermes bundle and both inlined values
(`ONESIGNAL_APP_ID`, `CITYSHIELD_API_URL`) but was never installed — no device was
attached. Note the Android build has not been run since the Firebase SDK and the
`google-services` Gradle plugin were removed, so expect to fix build fallout.

- [ ] Build and install: `frontend\build-apk.bat` (defaults already point at the deployed
      Worker and the real OneSignal app id). Docker equivalent:
      `export ONESIGNAL_APP_ID=… CITYSHIELD_API_URL=… && make release && make install-release`.
- [ ] Sign in, then confirm the device appears in OneSignal → Audience with `external_id`
      equal to the account's `user_id` (visible in the GDPR export or `GET /api/auth/me`).
      Signing in is what creates the subscription — there is no "register device" step.
- [ ] Fire a single-user test push with `python tools/push-tester/app.py`. Reading the
      result: `200` with `sent: 0` means the alias is unknown, the Worker has no
      OneSignal credentials, or the phone is registered against a different deployment.
- [ ] Inject a real alert (`POST /api/alerts/submit-data`) and confirm it both pushes and
      renders on the map with the right polygon/pin.
- [ ] **Cold-start inbox check:** kill the app, inject an alert, reopen it — the alert
      should be listed. This path (inbox filled from `/api/alerts/recent`) replaced
      Firebase's `setBackgroundMessageHandler`, so it is the regression most worth
      checking by hand.
- [ ] 🧑 Confirm the OneSignal Android settings carry the FCM service-account JSON **and**
      a package name matching the app's `applicationId` — a mismatch means devices
      subscribe and then silently receive nothing (SETUP §2).

## 2. Deployment hygiene

- [ ] **Redeploy.** The live Worker predates several changes — migrations 0009–0014, the
      erpsever.bg contract fix, the ViK id-probe crawler, ISO datetimes, the 4-hour VT
      interval, and everything from the 28.07 review fix — unless
      `npx wrangler deployments list` says otherwise. Apply the migrations remotely
      **first** (`npm run db:remote`) and confirm with
      `npx wrangler d1 migrations list --remote`. Ordering is load-bearing now:
      `getRegions` reads `region_aliases` (0013), so a Worker deployed ahead of its
      migrations fails every alert it tries to target.
- [ ] **Merge `cloudflare-migration` into `main`.** `main` still holds the retired
      pre-Cloudflare stack (50 commits behind), and CI's `deploy` job only runs on `main`,
      so nothing auto-deploys until this happens.
- [ ] 🧑 Create the `CLOUDFLARE_API_TOKEN` repo secret so that deploy job actually works —
      status unverified (SETUP §3).
- [ ] 🧑 Rotate `ONESIGNAL_API_KEY`; it passed through a chat transcript (SETUP §2).

## 3. Watch a real ingestion window

Both ingestion outages so far — epro's changed API contract and ViK's region-scoped
listing — looked perfectly healthy in the logs. After the redeploy, spend 48 hours
confirming the pipeline against the source websites themselves:

- [ ] Each of the four sources ingests ≥1 real message end to end. Highest priority:
      **epro** (new per-region contract), **vik** (id-probe walk should now surface
      outages outside the city — Devnya, Provadia, Dolni Chiflik, Dalgopol, plus planned
      repairs) and **vt** (varnatraffic.com was returning 503 to everyone at smoke time).
- [ ] Confirm ticks are really firing: `wrangler tail`, checking the `event.cron` value
      *and* a non-zero CPU time — the schedules API has reported schedules that do not
      match what fires (SPEC §3.8).
- [ ] Sanity-check a polygon alert's geometry and a city-wide alert's audience against
      what the sources actually said.

## 4. Email delivery (blocked on one decision)

Verification and password reset work end to end except that nothing is sent:
`backend/src/core/mailer.ts` composes each message and logs the link. `SELF_URL` is
already pinned, so links are correct the moment delivery is real.

- [ ] 🧑 Decide whether to register a domain — the provider choice follows from it
      (with: Resend; without: Brevo from a validated single address). SETUP §5.
- [ ] Implement `deliver` against the chosen provider, add its credentials to `Env`,
      delete the mock notice.
- [ ] Add the provider to the processor lists in `src/api/privacy.ts` (both languages)
      and COMPLIANCE.md §5, and widen the Play Data Safety purpose for email to include
      Account management.

## 5. Release paperwork and the Play listing 🧑

All operator items; detail in SETUP §6–7 and COMPLIANCE.md §1, §5.

- [ ] Google Play developer account (identity verification takes days).
- [ ] Decide the real package name (`com.cityshield.fcmtest` is a test package, permanent
      once published, and must be re-registered in OneSignal when changed).
- [ ] Store listing assets + privacy-policy URL.
- [ ] Accept the Cloudflare DPA, the OneSignal DPA (recording DPF or SCCs), and Google's
      Data Processing Terms; submit the Play Data Safety form.

## 5a. Still in a dev/test posture — must change before anyone else installs this

Everything here is deliberate for end-to-end testing and unsafe the moment the APK
reaches a device that is not ours. Grouped separately from §5 because these are
security properties, not paperwork.

- [ ] **Release signing key.** `android/app/build.gradle` points the *release* buildType
      at `signingConfigs.debug`, and that keystore is committed (the root `.gitignore`
      un-ignores `frontend/android/app/debug.keystore`) with the published Android
      defaults — `android` / `androiddebugkey` / `android`. Anyone with the repo can
      therefore build an APK Android accepts as an **in-place update** to an installed
      CityShield, inheriting its storage (both auth tokens) and its push registration.
      Play rejects debug-signed uploads too, so this blocks release regardless.
      Generate a real upload key, keep it out of the repo, and back it up — a lost
      upload key cannot be replaced without Google's help.
- [ ] **OneSignal identity verification is off.** `OneSignal.login(userId)` claims an
      `external_id` with no proof, so anyone who learns another account's `user_id`
      could subscribe their own device to that user's pushes. The ids are UUIDv4 and
      only ever returned to their owner, so this is not currently reachable — but the
      fix (enable Identity Verification in the dashboard, have the Worker sign a user
      JWT and the app pass it to `login()`) is the difference between "unguessable" and
      "authenticated".
- [ ] 🧑 Rotate `INGEST_API_KEY` before release if the deployed value ever came from
      `.dev.vars.example`. `/api/alerts/submit-data` and `/api/alerts/test-push` are
      behind it, and the second can broadcast to every registered device.
- [ ] Confirm `workers_dev` and the `*.workers.dev` hostname are still what you want to
      ship in the Play listing, or take the custom domain in §6 first.

Already handled, listed so they are not re-litigated: cleartext HTTP is now denied in
release builds and permitted only in `src/debug/res/xml` (the emulator's loopback
alias); `allowBackup="false"` is set, which is what keeps the unencrypted AsyncStorage
tokens off `adb backup` and Google backup.

## 6. Deferred — deliberately not doing yet

Each of these has a trigger; none is worth doing before it fires.

| Item | Do it when |
|---|---|
| In-memory trigram index for the fuzzy matcher | The streets table grows enough that the linear scan shows up in CPU time. D1-stored trigrams were evaluated and rejected |
| Workers Paid ($5/mo, 30 s CPU) | Polygon building actually exceeds the 10 ms budget in `wrangler tail`, not before |
| AI Gateway for request logs | Debugging an AI-quality problem that the current logs cannot explain |
| Custom domain | §4 goes the Resend route, or the workers.dev URL becomes a problem for the listing |
| Paid/self-hosted map tiles | Traffic grows enough to matter under the OSM tile usage policy |
| Hard email-verification enforcement | Signup spam appears; login works unverified today by design |
| Per-source polling changes | A source's publishing rhythm changes — intervals live in `src/ingestion/schedule.ts` |
| A street→region link, so guard A6 can widen a street-only alert | Real users show that vik's "в района на ул. X" with no district named is reaching too few of them. Nearest-region-centroid is the cheap version and is a crude Voronoi — a street near a boundary targets the wrong district — so it needs users to measure against before it is worth shipping |
