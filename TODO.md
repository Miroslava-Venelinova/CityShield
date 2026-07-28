# CityShield — remaining work

The Cloudflare migration is finished and the app runs on a real device: the APK built
against OneSignal is installed, sign-in works and push delivery is proven end to end.
What the system *does* is specified in [SPEC.md](SPEC.md); this file is only what is
still open.

Two things are left, and they are independent of each other:

- **Backend: accuracy, not features.** The pipeline works; what it gets wrong is *which
  place* an alert names and *who* therefore gets notified (§2).
- **Release: everything Google Play wants** before the app can be published (§4–§5),
  most of which is calendar time rather than work.

Items marked 🧑 need the operator (accounts, payments, decisions) — see [SETUP.md](SETUP.md).

---

## 1. Deployment hygiene

- [ ] **Redeploy.** The live Worker predates several changes — migrations 0009–0014, the
      erpsever.bg contract fix, the ViK id-probe crawler, ISO datetimes, the 4-hour VT
      interval, and everything from the 28.07 review fix — unless
      `npx wrangler deployments list` says otherwise. Apply the migrations remotely
      **first** (`npm run db:remote`) and confirm with
      `npx wrangler d1 migrations list --remote`. Ordering is load-bearing now:
      `getRegions` reads `region_aliases` (0013) and `insertAlert` writes `windows_json`
      (0012), so a Worker deployed ahead of its migrations fails every alert it handles.
- [ ] **Merge `cloudflare-migration` into `main`.** `main` still holds the retired
      pre-Cloudflare stack (50 commits behind), and CI's `deploy` job only runs on `main`,
      so nothing auto-deploys until this happens.
- [ ] 🧑 Create the `CLOUDFLARE_API_TOKEN` repo secret so that deploy job actually works —
      status unverified (SETUP §3).
- [ ] 🧑 Rotate `ONESIGNAL_API_KEY`; it passed through a chat transcript (SETUP §2).

## 2. Notification accuracy — the remaining backend work

The 28.07 review (99 alerts: 54 accurate, 33 inaccurate) produced the guards, the
kind-aware matcher and the schedule model that shipped in `6deac05`. Those fixes were
validated against *stored* parses; what they do to *fresh* ingestion is unmeasured.

- [ ] **Re-run the review loop.** After the redeploy, let a few days of alerts accumulate
      and run `tools/alert-review` over them. This is the measurement that decides
      everything below — do not act on any of it before the numbers exist.
      The buckets to watch, in the order they were expected to shrink: name ambiguity
      (should be gone), epro's `гр. X - кв. Y` districts (should be gone), multi-day
      windows (should render as a recurrence), unintended city-wide broadcasts (should
      be impossible without an explicit city-wide phrase).
- [ ] **Dropped locations from long lists.** The one failure class with no deterministic
      fix: a 5-village list where the model silently loses one (`с. Припек`). The eval
      corpus has a long-list case; if fresh alerts show it recurring, the answer is a
      count check — ask the model how many places it found, and re-prompt on a mismatch —
      not a better sentence in the prompt.
- [ ] **Grow `region_aliases` from what the sources actually write.** The table (0013)
      holds two rows today. Every name the review flags as unmatched but obviously real
      is an alias row, and an alias is cheaper and more exact than loosening the matcher.
- [ ] **Watch the matcher's threshold.** B1 raised core-comparison to 0.40 with clean
      separation over the 102 names seen so far. New source text can land in the gap;
      a name that should match and scores 0.35 is an alias row, not a lower threshold.
- [ ] **CPU headroom.** `place-names.ts` added per-candidate parsing on top of the trigram
      scan, against a 10 ms budget. If `wrangler tail` shows alert handling approaching
      it, the in-memory trigram index in §6 is the fix — measure first.

## 3. Email delivery — via OneSignal, once the domain is bought

Verification and password reset work end to end except that nothing is sent:
`backend/src/core/mailer.ts` composes each message and logs the link. `SELF_URL` is
already pinned, so links are correct the moment delivery is real.

**Decided:** send through OneSignal rather than adding Resend or Brevo. It is already a
processor for push, so the privacy policy, the DPA and the Data Safety form gain no new
third party — they only need amending (COMPLIANCE §5). 🧑 A domain is being registered,
which is what makes any of this deliverable: sending as `cityshield.varna@gmail.com`
through a third party fails SPF/DKIM alignment.

- [ ] 🧑 Buy the domain and point it at Cloudflare (~$10/yr at Cloudflare Registrar).
- [ ] 🧑 Verify OneSignal's email channel is actually a fit before writing code — three
      things to confirm on the dashboard, all cheap to check and expensive to discover
      late: what the **free plan** includes for email volume; whether **transactional**
      mail can go without OneSignal's unsubscribe footer and branding; and that a
      **sending domain** can be verified with the DNS records they ask for.
      If any of the three fails, Resend is the fallback and §3's "no new processor"
      advantage disappears — that is the only thing that would change the decision.
- [ ] 🧑 Set up the sending domain in OneSignal (DKIM/SPF/return-path DNS records).
- [ ] Implement `deliver` in `mailer.ts`. Email is a **separate subscription type** in
      OneSignal, not a property of the push user: the address has to be attached to the
      user via their Users API before a notification can target the email channel. That
      is the real work here — the send call itself mirrors `onesignal.ts`.
- [ ] Amend, do not extend, the paperwork: OneSignal's entry in `src/api/privacy.ts`
      (both languages) and COMPLIANCE.md §5 currently say it receives the account id and
      push registration **and never the email address**. That stops being true.
- [ ] Widen the Play Data Safety purpose for the email address to include Account
      management.
- [ ] Once mail is real, decide whether to enforce verification at login — today signup
      works unverified by design, because nothing could be delivered.

## 4. Google Play release 🧑

Detail in [SETUP.md](SETUP.md) §6–7 and [COMPLIANCE.md](COMPLIANCE.md) §1, §5. Ordered by
lead time, not by effort: the first two items are measured in weeks and gate the rest.

### 4.1 Account and the testing track — start these first

- [ ] **Google Play developer account** ($25, one-time). Identity and address
      verification takes days; for an organization account it also needs a D-U-N-S
      number, which takes longer.
- [ ] **The closed-testing requirement.** A *personal* developer account created after
      Nov 2023 cannot publish to production until the app has run a closed test with
      **12 testers opted in continuously for 14 days**. This is the single longest pole
      in the release: it needs a dozen real Google accounts, a tester list, and two
      unbroken weeks. Confirm whether it applies to the account type being registered
      before planning around it — an organization account is exempt.

### 4.2 Build and signing — blocks the first upload

- [ ] **Release signing key.** `android/app/build.gradle` points the *release* buildType
      at `signingConfigs.debug`, and that keystore is committed (the root `.gitignore`
      un-ignores `frontend/android/app/debug.keystore`) with the published Android
      defaults — `android` / `androiddebugkey` / `android`. Anyone with the repo can
      therefore build an APK Android accepts as an **in-place update** to an installed
      CityShield, inheriting its storage (both auth tokens) and its push registration.
      Play rejects debug-signed uploads too, so this blocks release regardless.
      Generate a real upload key, keep it out of the repo, and back it up — a lost
      upload key cannot be replaced without Google's help. Enrol in Play App Signing at
      the same time. Note the signatures differ, so the currently installed build has to
      be uninstalled before a properly signed one will install.
- [ ] **Ship an App Bundle, not an APK.** Play has required `.aab` for new apps since
      2021; `scripts/build.sh`, `build-apk.bat` and the `Makefile` all run
      `assembleRelease`. Add a `bundleRelease` path that produces
      `android/app/build/outputs/bundle/release/app-release.aab`. Keep the APK path —
      it is still how the app gets onto a phone directly.
- [ ] **Decide the real package name.** `com.cityshield.fcmtest` is a test package,
      permanent once published, and must be re-registered in OneSignal when changed
      (a mismatched package name means devices subscribe and then silently receive
      nothing). Change it *before* the first upload.
- [ ] **Versioning.** `versionCode 1` / `versionName "1.0"` is fine for the first
      upload, but Play rejects a re-upload at the same `versionCode` — every build that
      reaches the console needs an increment.
- [ ] `targetSdkVersion 36` and `minSdkVersion 24` already satisfy Play's current target
      requirement; re-check it at upload time, since the floor rises each August.

### 4.3 Console declarations

- [ ] **Data safety form** — answers are pre-filled in COMPLIANCE.md §1. Must match what
      `/privacy` says, including whatever §3 changes about email.
- [ ] **Account deletion URL.** Play requires apps with accounts to offer deletion
      *both* in the app and at a public web URL. In-app deletion exists
      (`DELETE /api/auth/me`, wired to Profile); the web page does not. Serve one from
      the Worker next to `/privacy` — it can be a static page explaining how to request
      deletion by email, but the URL has to exist and be entered in the console.
- [ ] **Content rating questionnaire** (IARC), **target audience and content**
      declaration, **ads declaration** (no ads), and the **government-apps / news**
      questions — CityShield republishes utility outage notices from public sources,
      which is worth answering carefully rather than quickly.
- [ ] **Privacy policy URL** — `https://cityshield.cityshield-varna.workers.dev/privacy`,
      or the custom-domain equivalent once §3's domain lands. Decide which URL ships
      *before* the listing is submitted; changing it later means re-review.

### 4.4 Store listing

- [ ] App name (≤30 chars), short description (≤80), full description (≤4000) — in
      **Bulgarian**, with English as a secondary locale if wanted.
- [ ] Icon 512×512, feature graphic 1024×500, and at least two phone screenshots.
      The launcher icon is already the CityShield mark; the store assets are separate
      files and do not exist yet.

## 5. Still in a dev/test posture

Security properties, not paperwork — deliberate for testing and unsafe the moment the app
reaches a device that is not ours. The release signing key belongs to this list too; it is
in §4.2 because it also blocks the upload.

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
      ship in the Play listing, or move to the §3 domain first.

Already handled, listed so they are not re-litigated: cleartext HTTP is now denied in
release builds and permitted only in `src/debug/res/xml` (the emulator's loopback
alias); `allowBackup="false"` is set, which is what keeps the unencrypted AsyncStorage
tokens off `adb backup` and Google backup; the app requests only `INTERNET` and
`POST_NOTIFICATIONS`, so there is no sensitive-permission declaration to file.

## 6. Deferred — deliberately not doing yet

Each of these has a trigger; none is worth doing before it fires.

| Item | Do it when |
|---|---|
| In-memory trigram index for the fuzzy matcher | The streets table grows, or `place-names.ts` parsing pushes alert handling toward the 10 ms budget in `wrangler tail`. D1-stored trigrams were evaluated and rejected |
| Workers Paid ($5/mo, 30 s CPU) | Polygon building actually exceeds the 10 ms budget, not before |
| AI Gateway for request logs | Debugging an AI-quality problem that the current logs cannot explain |
| Paid/self-hosted map tiles | Traffic grows enough to matter under the OSM tile usage policy |
| Per-source polling changes | A source's publishing rhythm changes — intervals live in `src/ingestion/schedule.ts` |
| A street→region link, so guard A6 can widen a street-only alert | Real users show that vik's "в района на ул. X" with no district named is reaching too few of them. Nearest-region-centroid is the cheap version and is a crude Voronoi — a street near a boundary targets the wrong district — so it needs users to measure against before it is worth shipping |
