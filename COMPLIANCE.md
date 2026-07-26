# CityShield — GDPR compliance record

Written record of the non-code compliance deliverables from [SPEC.md](SPEC.md)
§2.4–2.6. The code-side items (erasure/export/clear-location endpoints,
retention cron, `/privacy` page, in-app privacy screen) live in the repo; this
file holds the decisions that only exist as prose.

Controller: the CityShield operator · contact `cityshield.varna@gmail.com` ·
supervisory authority: Комисия за защита на личните данни (CPDP, cpdp.bg).

Last reviewed: 21 July 2026. Re-review whenever a new data field, processor or
data source is added.

---

## 1. Google Play Data Safety form

Answers to give in Play Console, consistent with `/privacy` (§2.5). All three
collected types are **collected, not shared**, **required** (not optional
beyond the location toggle), used **only for App functionality**, encrypted in
transit (HTTPS-only), and deletable in-app.

| Play category | Data type | Collected | Shared | Purpose | Required? |
|---|---|---|---|---|---|
| Personal info | Email address | Yes | No | App functionality (account, sign-in) | Required |
| Location | Approximate + precise location | Yes | No | App functionality (matching outage alerts to the user's district/street) | **Optional** — user-initiated, works without it |
| Device or other IDs | Device or other IDs (OneSignal push subscription) | Yes | No | App functionality (notification delivery) | Required for push |

Companion answers:

- **Is all user data encrypted in transit?** Yes — the API is HTTPS-only and
  Android release builds block cleartext (`network_security_config.xml`).
- **Can users request data deletion?** Yes — in-app (Profile → Privacy & Data →
  Delete My Account) and by email. Deletion is immediate and cascades.
- **Data collected for advertising/analytics?** No. No ads SDK, no analytics
  SDK, no tracking across apps.
- **Data shared with third parties?** No. Cloudflare, OneSignal (with Google
  FCM beneath it as the Android delivery channel) and OSMF Nominatim are
  processors/service providers, which Play's form does not count as "sharing";
  they are still listed in the privacy policy.
- **Does the app handle sensitive permissions?** `POST_NOTIFICATIONS` only. No
  runtime GPS permission — the user picks a point on a map, so the device's
  location is never read.
- **Privacy policy URL:** `https://<api-host>/privacy` (served by the Worker).
- **Account deletion URL** (required when accounts can be created in-app):
  the same `/privacy` page documents the in-app path; give the Play listing
  the `/privacy` URL.

Keep the form and the policy in sync: changing one without the other is itself
a Play policy violation.

## 2. DPIA assessment — not required (Art. 35)

**Conclusion: no DPIA needed. Reasoning kept here per §2.5.**

CityShield does not meet the Art. 35(1) "high risk" threshold, nor any entry on
the CPDP's list of processing operations requiring a DPIA. The processing is a
single-purpose outage-notification service: it stores an email, a password
hash and one self-declared home coordinate, and hands a push provider nothing
but that account's id. There is **no
systematic monitoring** — the location is a static point the user sets by hand
(and can clear), not a tracked trajectory; the app never reads device GPS and
records no movement, no history, no behavioural profile. There is **no
large-scale processing** in the Art. 35(3)(b) sense — the user base is
residents of one city, the data per user is four fields, and no special
categories (Art. 9) or criminal-conviction data (Art. 10) are involved. There
is **no automated decision-making** with legal or similarly significant effects
— the only automated decision is whether a given outage notice is geographically
relevant to a user, whose worst-case failure is a missed or irrelevant push
notification. The only genuinely sensitive element, the home coordinate, is
consent-based, optional, minimised (stored once, resolved to a district/street),
and erasable in one tap.

Revisit this conclusion if any of the following changes: continuous or
background location tracking is added; location history is retained; the
service expands to systematic monitoring of a publicly accessible area; or
special-category data enters the system.

## 3. DPO assessment — not required (Art. 37)

No DPO is appointed. CityShield is not a public authority; its core activities
do not consist of regular and systematic monitoring of data subjects on a large
scale (see §2 above); and it processes no Art. 9/10 data on a large scale.
Bulgaria abolished general controller registration with the CPDP after GDPR
took effect, so no filing is due either. Data-subject requests go to the
controller's contact address published in `/privacy`.

## 4. Breach notification runbook (Art. 33/34)

Deadline: notify the CPDP **within 72 hours** of becoming aware of a personal
data breach, unless it is unlikely to result in a risk to data subjects.

1. **Detect.** Sources: Cloudflare Workers Logs and D1 metrics (unexpected
   error/traffic patterns, mass 401s, unusual `GET /api/auth/me/export` or
   `DELETE` volume), a leaked-secret alert (JWT signing key, OneSignal REST API
   key), or a third-party report.
2. **Contain.** Rotate the affected secret immediately
   (`wrangler secret put …` — rotating `JWT_SECRET` invalidates every session,
   which is the intended effect during a credential breach), and if data was
   altered or destroyed, restore with D1 Time Travel
   (`wrangler d1 time-travel restore`, 7-day window on the free plan).
3. **Assess scope.** From the logs, determine which endpoints and which
   user records were reached, and which categories were involved: emails +
   password hashes, or home coordinates. Home coordinates are the highest-risk
   item. Push registrations are no longer in our database at all — a leaked
   OneSignal REST API key means someone could send pushes to our users, not read
   their data. Note that alert content is public utility information, not
   personal data.
4. **Notify the CPDP** via the form at cpdp.bg within 72 hours: nature of the
   breach, categories and approximate number of data subjects and records,
   contact point, likely consequences, measures taken. If the full picture is
   not ready, file within 72 hours anyway and supplement (Art. 33(4)).
5. **Notify users** (Art. 34) when the risk is high — e.g. home coordinates or
   password hashes exposed — via push and email, in plain language, with
   what happened and what to do (change password; the location can be cleared
   from settings).
6. **Record it.** Every breach, notifiable or not, is logged in this file's
   revision history with date, facts, effects and remedial action (Art. 33(5)).

No breaches to date.

## 5. Processor paperwork status

Per §2.2 — confirm each before the Play release:

- [ ] Cloudflare DPA accepted and a copy downloaded; D1 created with
      `--location=weur`.
- [ ] **OneSignal DPA accepted** and a copy downloaded. OneSignal is a US
      processor, so confirm the transfer mechanism it offers (DPF certification
      or SCCs) and record which one applies. It receives the account `user_id`
      and the device push registration — never location, email or preferences.
- [ ] Google/Firebase Data Processing Terms accepted in the Firebase console.
      Still required: OneSignal delivers to Android through our Firebase
      project, so FCM remains in the chain even though we no longer call it.
- [ ] **Email provider — not chosen, and none engaged.** Verification and reset
      mail is mocked (`backend/src/core/mailer.ts` logs each link), so no
      processor receives user addresses today and none is listed in `/privacy`.
      Before those flows go live: accept the provider's DPA, confirm where it
      processes data (an EU provider needs no transfer mechanism; a US one needs
      DPF or SCCs), add it to the processor list in `/privacy` **and** to the
      table above, and widen the Play Data Safety purpose for the email address
      to include Account management. It will receive only the recipient address
      and the message body — never location data.
- [x] OSMF Nominatim — no DPA available; documented decision is to disclose the
      transfer in the in-app consent copy (Profile → Set Location) and in
      `/privacy`, and to send no user identifier with the request.
