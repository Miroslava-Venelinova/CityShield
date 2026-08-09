# CityShield — remaining work and operator setup

The Cloudflare migration is finished and the app runs on a real device: the APK built
against OneSignal is installed, sign-in works and push delivery is proven end to end.
What the system *does* is specified in [SPEC.md](SPEC.md); this file is only what is
still open.

Two things are left, and they are independent of each other:

- **Backend: accuracy, not features.** The pipeline works; what it gets wrong is *which
  place* an alert names and *who* therefore gets notified (§2).
- **Release: everything Google Play wants** before the app can be published (§4–§5),
  most of which is calendar time rather than work.

Items marked 🧑 need the operator (accounts, payments, decisions); §7 is the checklist
of what only you can provide, and the work items point into it.

---

## 1. Deployment hygiene

- [x] ~~**Redeploy.**~~ Done 30.07.2026 while fixing the CPU outage — the live Worker was
      still the 28.07 18:43 build, so it also predated the 28.07 review fix's normalize
      change (`7c3bbd9`, a district's own streets follow it out from under the city).
      Migrations 0009–0014 were already applied remotely, confirmed with
      `npx wrangler d1 migrations list --remote` before deploying. Keep the ordering rule
      in mind for next time: `getRegions` reads `region_aliases` (0013) and `insertAlert`
      writes `windows_json` (0012), so a Worker deployed ahead of its migrations fails
      every alert it handles.
- [ ] **Merge `cloudflare-migration` into `main`.** `main` still holds the retired
      pre-Cloudflare stack (50 commits behind), and CI's `deploy` job only runs on `main`,
      so nothing auto-deploys until this happens.
- [ ] 🧑 Create the `CLOUDFLARE_API_TOKEN` repo secret so that deploy job actually works —
      status unverified (§7.3).
- [ ] 🧑 Rotate `ONESIGNAL_API_KEY`; it passed through a chat transcript (§7.2).

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
- [ ] **Seed the village streets.** Migration 0015 and everything around it landed on
      31.07.2026 — `streets` now carries a settlement, targeting and enrichment are
      scoped by it, and `tools/osm-seed-builder` extracts one settlement at a time. What
      has *not* happened is the extraction itself: the table still holds only the 1,333
      Варна streets, so villages keep falling through to Nominatim exactly as before.
      Nothing is wrong until this runs; it is the payoff that is missing.
      Do община Варна first (the ~99 regions inside the 15 km city-wide radius, where the
      users are), against the self-hosted Overpass — the public endpoints rate-limited
      after three queries when this was tried. Use the *around a settlement* kind: most
      villages have no boundary relation to query. Then extend to the rest of the
      province; vik does publish Долни чифлик and Аврен.
      Two checks after applying, both in SPEC §1.2: the street count matches the JSON
      (a settlement missing from `regions` inserts nothing, silently), and the
      **startup budget** `wrangler deploy` prints — it was 27 ms against 400 ms, and the
      seed growing ~4× is the one number worth watching.
- [ ] **Grow `region_aliases` from what the sources actually write.** The table (0013)
      holds two rows today. Every name the review flags as unmatched but obviously real
      is an alias row, and an alias is cheaper and more exact than loosening the matcher.
- [ ] **Watch the matcher's threshold.** B1 raised core-comparison to 0.40 with clean
      separation over the 102 names seen so far. New source text can land in the gap;
      a name that should match and scores 0.35 is an alias row, not a lower threshold.
- [x] ~~**CPU headroom.**~~ Fired on 30.07.2026 before anyone measured it, and took
      ingestion down for 20 hours: every tick died at `exceededCpu`, so no cursor moved
      and six real ViK outages went unsent. `prepare()` cost ~11.6 ms in one synchronous
      burst on a cold isolate — and a 15-minute cron is a cold isolate every time. Fixed
      by building the per-name data at module evaluation (§1.3), 11.6 ms → 1.27 ms. The
      in-memory trigram index below would **not** have fixed it: an index is still built
      per isolate on first use. Read SPEC.md §1.1 on what the 10 ms actually bounds.
- [ ] **A message that cannot be processed still pins the cursor forever.** This is what
      turned one over-budget message into a 20-hour outage instead of one late alert. The
      design is deliberate for the transient cases — oldest-first, advance only past
      successes — and `MAX_PUSH_ATTEMPTS` already caps the one failure that repeats
      (a dead push). Nothing caps a message that fails *before* the store.
      The awkward part: an `exceededCpu` kill runs no more code, so an attempt counter
      written after the failure never gets written. It has to be written *before* the
      heavy work and cleared on success — one extra D1 write per message per tick — and
      then N strikes means skipping a real public-safety alert on purpose. That trade is
      a product decision, not a refactor, which is why this is a checkbox and not a
      patch. Cheap partial credit meanwhile: alert on a `crawl_state.updated_at` that
      has not moved in a few hours (SPEC.md §3.8 has the query).
- [ ] **Workers AI is timing out far more than spike 2 measured — watch this.** Over the
      three recovery ticks on 30.07.2026: **6 `AI.run timed out after 30000 ms` against 8
      messages ingested**, and one epro message exhausted all 3 attempts and was deferred
      to the next tick. Spike 2 clocked qwen3-30b at 4–21 s, which is what `RUN_TIMEOUT_MS
      = 30_000` was sized for; it is now routinely past 30 s.
      Why it matters beyond wasted neurons: a message can burn 90 s in retries, and the
      10:00 tick used **175.9 s of the then-180 s `DEADLINE_MS`** (raised to 5 min on
      31.07.2026 to buy headroom — that bought time, it did not fix this). Past it the runner starts
      logging "Deadline reached before '<source>'" and skipping sources — so this
      degrades into *missed* alerts rather than slow ones, from a direction the deadline
      design did not anticipate (it assumed the AI was fast and Overpass was the risk).
      Do not just raise the timeout — that makes starvation more likely, not less.
      Measure first: whether this is a transient Workers AI condition or the new normal
      decides between a faster/smaller model, fewer attempts, and one message per tick.

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

Detail in §7.6–§7.7 and [COMPLIANCE.md](COMPLIANCE.md) §1, §5. Ordered by
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
| In-memory trigram index for the fuzzy matcher | `bestMatch` — not `place-names` — shows up as a burst in `wrangler tail`. Largely overtaken: the matcher's cold cost is now 1.27 ms because the per-name data is built at startup (SPEC.md §1.3), and an index would be built per isolate. D1-stored trigrams were evaluated and rejected |
| Workers Paid ($5/mo, 30 s CPU) | A single irreducible operation exceeds the 10 ms *burst* ceiling, not before. Polygon building came close on 30.07.2026 — buffering the road network doubled its cost — and was solved by yielding between stages instead, worst cold burst 14 → 6 ms. SPEC §1.9 lists exactly what the paid plan would let us delete, and what stays regardless. Note the 30.07.2026 outage did **not** need it either: more total CPU does not raise a burst ceiling, and that burst was avoidable work |
| Granting the wrangler token observability scope | Before the next incident. Without it, historical Worker logs cannot be queried at all and diagnosis costs one 15-minute cron cycle per data point (SPEC.md §3.8) |
| AI Gateway for request logs | Debugging an AI-quality problem that the current logs cannot explain |
| Paid/self-hosted map tiles | Traffic grows enough to matter under the OSM tile usage policy |
| Per-source polling changes | A source's publishing rhythm changes — intervals live in `src/ingestion/schedule.ts` |
| A street→region link, so guard A6 can widen a street-only alert | Real users show that vik's "в района на ул. X" with no district named is reaching too few of them. Nearest-region-centroid is the cheap version and is a crude Voronoi — a street near a boundary targets the wrong district — so it needs users to measure against before it is worth shipping |

## 7. Operator setup — what you personally need to provide

Everything else (code, secret generation, D1 creation, deploys) is handled in the repo;
the items here need you because they involve accounts, payment identity, or decisions
only the operator can make. Technical detail lives in [SPEC.md](SPEC.md) §3.

Legend: ✅ done · ⏳ waiting on you · 💤 not needed yet.

### 7.1 ✅ Cloudflare account

Account `cityshield.varna@gmail.com`, `wrangler login` completed 2026-07-19. D1 lives in
`weur`; the Worker is deployed at `https://cityshield.cityshield-varna.workers.dev`, with
`JWT_KEY`, `INGEST_API_KEY` and `ONESIGNAL_API_KEY` stored as Worker secrets.

Note for anyone re-provisioning: Workers AI **does not work on throwaway preview
accounts** — a real account is genuinely required, but the free plan is enough for
everything specced.

### 7.2 Push notifications — OneSignal app

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

### 7.3 ⏳ CI auto-deploys — one API token, one GitHub secret

- Cloudflare dashboard → My Profile → API Tokens → create from the **"Edit Cloudflare
  Workers"** template, scoped to your account.
- Add it to the GitHub repo as the secret `CLOUDFLARE_API_TOKEN`.

Whether this was ever done is unverified (there is no `gh` CLI on the dev machine to
check). Until it is, the `deploy` job in CI is a no-op and deploys happen by hand with
`npx wrangler deploy`.

### 7.4 ✅ Privacy policy — decided

- Controller contact published in the policy: **cityshield.varna@gmail.com**
  (confirmed 2026-07-21).
- Policy languages: Bulgarian + English, both served at `/privacy`.

### 7.5 ⏳ Email verification & password reset — provider decided, domain pending

Both flows are built and tested, but **delivery is mocked**: the Worker composes each
message and logs its link instead of sending it ([backend/src/core/mailer.ts](backend/src/core/mailer.ts)).
Nobody can receive a verification or reset link until delivery is wired up.

**Decided: send through OneSignal**, the same account that already delivers push. The
reason is not the code — it is the paperwork. Any other provider (Resend, Brevo) is a
*new* processor: its own DPA, its own row in `/privacy` in both languages, its own entry
in COMPLIANCE.md §5. OneSignal is already all of those, so the change is an amendment
rather than an addition.

⏳ **What is on you:**

- **Register the domain** (~$10/yr at Cloudflare Registrar). Sending as
  `cityshield.varna@gmail.com` through any third party fails SPF/DKIM alignment
  (gmail.com does not authorize them), so reset links land in spam often enough to
  matter. A domain is the only real fix, and it also gives the API and the Play listing
  a real URL.
- **Confirm OneSignal's email channel actually fits**, before any code is written —
  three questions, all answerable from the dashboard and its pricing page:
  what the **free plan** allows for email volume; whether **transactional** mail can go
  without OneSignal's unsubscribe footer and branding; and that a **sending domain** can
  be verified with the DNS records they require. If any answer is no, Resend is the
  fallback and the "no new processor" advantage is gone — that is the one thing that
  would reopen the decision.
- **Set up the sending domain** in OneSignal once bought (DKIM/SPF/return-path records).

Then the work is one function (`deliver` in `mailer.ts`) — noting that an email address
is a *separate subscription* on the OneSignal user, so it has to be attached through
their Users API before a notification can target the email channel — plus paperwork:
amend OneSignal's description in `/privacy` and COMPLIANCE.md §5 (both currently promise
it never receives an email address) and widen the Play Data Safety purpose for email to
include Account management. The work items are §3.

### 7.6 ⏳ Play Store release — the things only you can hold

- **Google Play developer account** (one-time $25). Needed before anything can be
  published; the identity/address verification Google now requires takes days, not
  minutes, so start it early if a release date matters. An organization account also
  needs a D-U-N-S number, which takes longer still.
- **The closed-testing wait, if the account is a personal one.** Personal developer
  accounts registered since late 2023 must run a closed test with **12 testers opted in
  continuously for 14 days** before production access is granted. That is a dozen real
  Google accounts and two unbroken weeks — by far the longest lead time in the release,
  and worth confirming against the current Play Console rules for the account type you
  register, since organization accounts are exempt.
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
  custom-domain equivalent once §7.5's domain is registered — decide which one ships
  before submitting the listing, since changing it later means re-review).
- **A public account-deletion URL.** Play requires one for any app with accounts, in
  addition to the in-app deletion the app already has. It does not exist yet; it will be
  served from the Worker next to `/privacy`, and the URL goes in the console.

### 7.7 ⏳ Processor paperwork (before the release)

Tracked with the reasoning in [COMPLIANCE.md](COMPLIANCE.md) §5; all are free and
self-service:

- Accept the **Cloudflare DPA** and download a copy.
- Accept the **OneSignal DPA**, and record which transfer mechanism applies (DPF or SCCs).
- Accept **Google's Data Processing Terms** in the Firebase console (FCM is still the
  Android delivery channel beneath OneSignal).
- Submit the **Play Data Safety form** using the filled-in answers in COMPLIANCE.md §1.

### 7.8 💤 Not needed from you

- `JWT_KEY`, `INGEST_API_KEY` — generated with `openssl rand` and stored as Worker secrets.
- ~~Custom domain~~ — moved to §7.5: it is now a prerequisite, because email cannot be
  delivered from a gmail.com address through a third party.
- AI Gateway ("cityshield", free, for AI request logs) — nice for debugging, not urgent.
- No other accounts: Nominatim and Overpass need no registration — we just follow their
  usage policies, which the code is built to respect ([SPEC.md](SPEC.md) §2.6).
