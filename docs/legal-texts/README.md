# Legal texts: drafts

Drafted on 29.10.2026 from [legal.md](../legal.md), [todo.md](../todo.md) §8,
[specification.md](../specification.md) §2, [compliance.md](../compliance.md) and the
current `/privacy` (`backend/src/api/privacy.ts`). Every claim about data, retention
and recipients was checked against `backend/src`, `backend/migrations` and
`frontend/src`. **No lawyer has reviewed these texts.** Bulgarian is the binding
version; each English file says it is a translation.

## Files

| File | What it is | Where it goes |
|---|---|---|
| `terms-of-use.bg.md` / `.en.md` | Terms of use: unofficial, verbatim republishing, automatic targeting, no guarantees, 18+, liability, Bulgarian law | Worker `GET /terms`; linked from sign-up and Profile |
| `privacy-policy.bg.md` / `.en.md` | Replaces today's `/privacy` | Worker `GET /privacy` |
| `in-app-notices.md` | First-launch notice, alert detail line, sign-up checkboxes, location consent, changed-terms prompt, corrections to existing strings, Play description paragraph | `frontend/src/i18n/translations.ts`; Play Console |
| `about-and-licences.md` | About screen text with OSM/ODbL attribution; build-time licence list | New Profile → About screen |

Not drafted here: the account-deletion page Play needs (todo §4.3).

## Placeholders

| Placeholder | Meaning | Decided by |
|---|---|---|
| `{{CONTROLLER_NAME}}` | Full name of the person, or the company name. Must match the Play developer name | Owner (legal.md §9 Q6) |
| `{{CONTROLLER_ADDRESS}}` | Postal address (GDPR Art. 13(1)(a)) | Owner; lawyer on whether a home address must be public (Q2) |
| `{{CONTROLLER_REGISTRATION}}` | ЕИК, only for a company. Otherwise delete the line | Owner |
| `{{CONTACT_PHONE}}` | Only if ЗЕТ чл. 4 applies. Otherwise delete the line | Lawyer (Q2) |
| `{{EFFECTIVE_DATE}}` | Date the version takes effect | Owner, at publication |
| `{{TERMS_VERSION}}`, `{{POLICY_VERSION}}` | Must be the same constants the Worker stores with acceptance and consent | Owner (suggest `2026-11-DD`) |
| `{{SITE_URL}}` | `https://cityshield.cityshield-varna.workers.dev` or the custom domain | Owner (todo §4.3, §7.5) |
| `{{SOURCE_NAME}}`, `{{APP_VERSION}}`, `{{ACCEPTED_TERMS_VERSION}}`, `{{LICENCES_LIST}}` | Filled at runtime or build time | Code |

The contact email is written in, not a placeholder: `cityshield.varna@gmail.com`
(decided 21.07.2026, todo §7.4). If the domain lands, change it in all six files.

Other markers to clear before publishing:

- `[ЗА ПРЕГЛЕД ОТ ЮРИСТ]` / `[LAWYER REVIEW]`: terms §8 (liability), §11 (notice
  period), §13 (law and courts).
- `[ПРОВЕРИ]` / `[VERIFY]`: OneSignal on the dataprivacyframework.gov list; the UK
  adequacy decision still in force (OSMF).
- Commented-out OneSignal email sentence in privacy §5: uncomment when mail goes live
  through OneSignal (todo §3), and widen the Data Safety email purpose at the same time.

## Assumptions: each must be true when the texts go live

1. **Leaflet is bundled into the APK** (in progress in another change), so the policy
   does not mention unpkg.com. Today `leafletWebView.ts` still loads it from unpkg. If
   that ships, add unpkg.com to privacy §5 as a recipient that sees the IP address.
2. **Terms acceptance and the 18+ statement are recorded** with a timestamp and terms
   version. Not in the code: `registerSchema` takes only email and password, and
   `users` has no such columns.
3. **Location consent is recorded** with a timestamp and policy version. Not in the
   code (todo §8.2): `PUT /api/auth/location` stores only coordinates, region and street.
4. **Every alert links to its original notice.** Not in the code (todo §8.4): no URL
   is stored (`alerts.source_ref` is `<category>:id=<n>`), the feed exposes only the
   category, and the push data carries only category and times.
5. The first-launch notice exists and stores a "seen" flag on the device (privacy §4
   lists it).
6. `{{SITE_URL}}/delete-account` exists.
7. Log retention is at most 7 days. Workers Logs keep 3 days on the Free plan and
   7 on Paid; check the dashboard. D1 Time Travel is 7 days on Free and **30 on
   Paid**: if the account moves to Paid, change privacy §6 and the deletion strings.
8. No off-site backup exists. If the weekly `wrangler d1 export` (todo §9.2) is added,
   privacy §6 must say where it is kept and for how long.
9. Privacy §6 promises to re-delete accounts deleted between a restore point and
   the restore. Add that step to the breach runbook (compliance.md §4). Deletion logs
   no user id, so take a list of current `user_id`s **before** restoring and diff it.
10. The OneSignal device data listed in privacy §5 (model, OS, language, time zone,
    app version, session times) is from OneSignal's documentation. Confirm it in the
    dashboard's subscription view.

## Discrepancies found

Code, docs and today's `/privacy` disagree on these. The drafts follow the code.

1. `/privacy` lists OSMF Nominatim as a **processor**. There is no DPA, so it is an
   independent recipient. The draft lists it under "other recipients".
2. `/privacy` leaves out the OSM tile servers, which see every map user's IP address.
   The draft adds them.
3. `/privacy` says "no cookies (API-only)". The app stores `auth_token`,
   `refresh_token`, `app_language`, `app_theme`, `cityshield_notifications`,
   `cityshield_notifications_dismissed`, the OneSignal SDK's data and the WebView's
   tile cache.
4. `/privacy` and the app (`profile.deleteConfirm2`, `profile.deleteDoneMsg`) say
   deletion is immediate and complete. D1 Time Travel keeps it for 7 days.
5. `/privacy` says OneSignal gets only the account id and the push registration. It
   also gets the notification text, which names the area, and device data from the
   SDK. `initPush()` runs in `index.js` before sign-in, so OneSignal registers every
   install, signed in or not. After sign-out the device's subscription stays at
   OneSignal, unlinked.
6. **Logs contain data that spec §2.1 says must never be logged.** `core/geocoding.ts`
   logs the user's coordinates when reverse geocoding fails (three lines), and
   `api/auth.ts` logs the user id on the same path. The mail mock (`core/mailer.ts`)
   logs the recipient's email **and the live verification or reset link** on every
   sign-up and reset request. The draft discloses this. It would be better to fix the
   code and then shorten the logs row in privacy §3.
7. The push is not purely verbatim. The title is cut at 120 characters, the body at
   1,000, and a machine-read time window is appended (`alert-service.ts`). Terms §3
   says so.
8. Spec §2.6 says "full articles are not republished". The code stores and pushes
   the full title and text, which is now the owner's decision. Update the spec.
9. Spec §2.6 says the About screen credits Nominatim and Overpass. It shows only
   "© OpenStreetMap" and a hard-coded "v1.0.0" (Gradle `versionName` is "1.0").
10. The app calls the power source "еПро" (`category.epro`, `home.howItWorksText`).
    The issuer is „Електроразпределение Север" АД, and attribution has to name it.
11. Spec §2.1 leaves out the verification and reset link hashes (`auth_tokens`) and
    the rate-limit counters, which are keyed by IP address or email. Spec §2.5 still
    lists "no cookies". compliance.md §2 says "four fields" per user; there are more.
12. `GET /api/auth/me/export` will need the acceptance and consent records once they
    exist.

## Owner decisions still open

- Controller: natural person or ЕООД (fills every `CONTROLLER_*`).
- Which URL ships: workers.dev or a domain.
- When email goes live through OneSignal.
- Version scheme, effective date, notice period for changing the terms.
- Whether to get no-objection replies from the four operators before release (todo
  §8.3). The terms assume verbatim republishing is allowed.
- **ODbL share-alike:** `backend/seeds/*.json` is a database derived from OSM, kept on
  GitHub. If the repo is public, offer the seed under the ODbL (a licence note in
  `backend/seeds`).
- Play: target audience 18+, distribution limited to Bulgaria, "Restrict minor access".

## Questions for the lawyer

legal.md §9 Q1–Q6 still apply. Specific to these drafts:

1. Terms §8: does the clause hold under ЗЗД чл. 45 and 94 and ЗЗП чл. 143 ал. 2 т. 1?
   Should it cap amounts?
2. Does ЗЗП apply? If it does: which consumer information duties and ADR reference
   are needed, and is §13 enough?
3. Terms §11: notice period, and is in-app re-acceptance a valid way to amend?
4. Verbatim republishing: is "the text belongs to the operator" with attribution and
   a link enough? This is Q5.
5. Location: is tapping "Задай локация" after the consent text a valid affirmative
   act, or is a checkbox needed? Or should the basis be contract?
6. Is Art. 6(1)(c) with Art. 7(1) the right basis for keeping consent records?
7. Does "Bulgarian prevails" hold against a consumer who was shown the English text?

## Wiring checklist

**Worker**

- [ ] `GET /privacy`: render both privacy files (BG first, EN below) in place of
      `POLICY_HTML`.
- [ ] `GET /terms`: both terms files. `GET /delete-account`: the Play deletion page.
- [ ] `TERMS_VERSION` and `POLICY_VERSION` constants in one place, sent to the app
      (e.g. the `/api/app-config` from todo §9.3).
- [ ] Migration: terms version and acceptance time, age statement time, location
      consent time and policy version on `users`.
- [ ] `POST /register` requires the terms version and the age statement.
      `PUT /location` records consent. `/me/export` includes both records.
- [ ] Store the source notice URL per alert; expose it in `/api/alerts/recent` and
      the push data.
- [ ] Drop coordinates and emails from log lines (discrepancy 6).

**App**

- [ ] First-launch notice and its stored flag (in-app-notices §1).
- [ ] Register: both checkboxes; Terms and Privacy open in the external browser
      before sign-up; send the terms version (§3).
- [ ] Set Location sheet: new consent text (§4).
- [ ] Alert detail sheet: disclaimer line and source link (§2).
- [ ] Rename "еПро" and fix the deletion strings (§6).
- [ ] Profile → About screen and licences screen (about-and-licences.md); add a
      Terms link under Privacy & Data.
- [ ] Changed-terms prompt (§5).

**Play listing**

- [ ] Full description paragraph in both locales (in-app-notices §7); no "Official".
- [ ] Privacy URL `{{SITE_URL}}/privacy`; deletion URL `{{SITE_URL}}/delete-account`.
- [ ] Developer name matches `{{CONTROLLER_NAME}}`.
- [ ] Target audience 18+; countries: Bulgaria; government-information answers.
- [ ] Data Safety (compliance.md §1) matches the new policy.

**Docs (not edited in this change)**

- [ ] compliance.md header and §5; specification §2.1, §2.2, §2.5, §2.6;
      add this folder to [docs/README.md](../README.md).
