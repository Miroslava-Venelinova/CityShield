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
      10:00 tick used **175.9 s of the 180 s `DEADLINE_MS`**. Past that the runner starts
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
| In-memory trigram index for the fuzzy matcher | `bestMatch` — not `place-names` — shows up as a burst in `wrangler tail`. Largely overtaken: the matcher's cold cost is now 1.27 ms because the per-name data is built at startup (SPEC.md §1.3), and an index would be built per isolate. D1-stored trigrams were evaluated and rejected |
| Workers Paid ($5/mo, 30 s CPU) | Polygon building actually exceeds the budget, not before. Note the 30.07.2026 outage did **not** need it: a 10 ms *burst* limit is not raised usefully by a plan that grants more total CPU, and the burst was avoidable work |
| Granting the wrangler token observability scope | Before the next incident. Without it, historical Worker logs cannot be queried at all and diagnosis costs one 15-minute cron cycle per data point (SPEC.md §3.8) |
| AI Gateway for request logs | Debugging an AI-quality problem that the current logs cannot explain |
| Paid/self-hosted map tiles | Traffic grows enough to matter under the OSM tile usage policy |
| Per-source polling changes | A source's publishing rhythm changes — intervals live in `src/ingestion/schedule.ts` |
| A street→region link, so guard A6 can widen a street-only alert | Real users show that vik's "в района на ул. X" with no district named is reaching too few of them. Nearest-region-centroid is the cheap version and is a crude Voronoi — a street near a boundary targets the wrong district — so it needs users to measure against before it is worth shipping |
