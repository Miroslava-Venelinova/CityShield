<!-- DRAFT. Before publishing: fill in {{...}}, resolve [VERIFY] and remove the markers. See README.md. -->

# CityShield Privacy Policy

**Version:** {{POLICY_VERSION}} · **Effective from:** {{EFFECTIVE_DATE}}

*This English text is a translation. If it differs from the Bulgarian text, the
Bulgarian text prevails.*

## 1. Who is responsible for your data

The data controller is {{CONTROLLER_NAME}}, {{CONTROLLER_ADDRESS}}.

<!-- Only if the controller is a company, otherwise delete the line: -->
Company number (ЕИК): {{CONTROLLER_REGISTRATION}}

Contact email: **cityshield.varna@gmail.com**

<!-- Only if the lawyer confirms ЗЕТ Art. 4 applies, otherwise delete the line: -->
Phone: {{CONTACT_PHONE}}

We have no data protection officer because we are not required to have one. For
anything about your data, write to the email above.

## 2. In short

- We keep only what we need to send you alerts: your email, your password (hashed
  only), your location if you choose to set it, and your settings.
- We collect no names or phone numbers. There are no ads, no behavioural analytics
  and no tracking. We do not sell data.
- You set your location yourself by picking a point on a map. The app does not read
  your phone's GPS and has no location permission.
- You can download and delete your data from inside the app.
- CityShield is only for people aged 18 and over.

## 3. What we process, why, and for how long

| Data | Purpose | Lawful basis (GDPR) | How long |
|---|---|---|---|
| Email, password (hashed only; we cannot see it), whether the email is confirmed, account creation and change dates | Account and sign-in; email confirmation and password reset messages | Contract, Art. 6(1)(b) | Until the account is deleted |
| When you accepted which version of the Terms of Use; your statement that you are 18 or over | To be able to prove acceptance | Contract and legitimate interest, Art. 6(1)(b) and (f) | Until the account is deleted |
| The point you picked on the map (coordinates), and the district and street worked out from it | Alerts for your area | **Consent**, Art. 6(1)(a) | Until you change or clear it, or delete the account |
| When you consented to location storage, and to which version of this policy | To be able to prove consent | Legal obligation, Art. 6(1)(c) with Art. 7(1) | Until the account is deleted |
| Alert categories you switched off, bus lines you picked | Sending you only the alerts you want | Contract | Until the account is deleted |
| Sign-in sessions (hashed keys only) | Keeping you signed in | Contract | 90 days from last use; signing out deletes that device's session |
| Email confirmation and password reset links (hashed only) | Account security | Contract | Valid 24 hours / 1 hour; deleted within 2 days of expiry |
| The link between your account and your phone at OneSignal | Delivering notifications | Contract | Until you sign out on that device or delete the account |
| Server logs: IP address, time and address of the request, app and device type (User-Agent), technical errors. Some error entries also contain your account id, email or the coordinates you set | Security and troubleshooting | Legitimate interest, Art. 6(1)(f) | Up to 7 days |
| Rate-limit counters (by IP address or email) | Protection against abuse such as password guessing | Legitimate interest | 60 seconds |

Outage notices are public information from the companies that issue them and are
not personal data. We keep them for 90 days.

## 4. What the app keeps on your phone

The app uses no cookies, but it stores the following on your phone:

- your sign-in keys (deleted when you sign out);
- your chosen language and light or dark theme;
- the last 10 alerts in the Alerts tab, and which of them you deleted;
- whether you have seen the first-launch notice;
- OneSignal's data: your notification subscription id and the push key issued by
  Google;
- temporarily cached map images.

All of this is needed for the service you asked for, so we do not ask for separate
consent (Art. 4a of the Bulgarian Electronic Commerce Act). It is removed when you
uninstall the app. The app does not back up to Google.

## 5. Who else receives data

### Processors: they act on our instructions under a contract with us

- **Cloudflare, Inc.** (USA): CityShield's server, database and logs. The database
  is stored in Western Europe. Cloudflare also runs the AI model that reads the
  outage notices; the model receives **only the public text of the notices**, no
  personal data. Transfer safeguards: data processing agreement, EU-US Data Privacy
  Framework (DPF) certification and standard contractual clauses.
- **OneSignal, Inc.** (USA): delivers notifications. It receives your account id (a
  random number, not your email), your phone's push registration, technical device
  information (e.g. model, Android version, language, time zone, app version, when
  the app was opened) and the text of the notifications sent to you, which may name
  your district. It does not receive your coordinates, email or settings.
  OneSignal's module starts when the app opens and registers the phone even before
  you sign in; that registration is not linked to any account until you do.
  Transfer safeguards: data processing agreement, standard contractual clauses and
  DPF certification [VERIFY: OneSignal on the dataprivacyframework.gov list].
  <!-- ENABLE when email is sent through OneSignal: -->
  <!-- Email confirmation and password reset messages are also sent through OneSignal; for these it receives your email address and the message text. -->
- **Google (Firebase Cloud Messaging)** (USA): the technical channel OneSignal uses
  to reach Android phones. Safeguards: Google's data processing terms, DPF and
  standard contractual clauses.

### Other recipients: they handle data under their own rules

- **OpenStreetMap Foundation, Nominatim service.** When you set a location, our
  server sends the coordinates to Nominatim to find the district and street. The
  request comes from our server, not from your phone, and carries no email, account
  id or IP address of yours.
- **OpenStreetMap Foundation, map tile servers (tile.openstreetmap.org).** The maps
  in the app load straight from your phone, so OSMF sees your IP address, your
  device type (User-Agent) and which part of the map you are looking at, including
  the area around your home while you pick a point.

OSMF is in the United Kingdom, which is covered by a European Commission adequacy
decision [VERIFY: the decision is in force]. OSMF's rules:
<https://osmfoundation.org/wiki/Privacy_Policy>.

We do not sell data or give it to advertisers. We disclose data to a public
authority only when the law requires us to.

## 6. Deletion and backups

- **"Delete My Account"** immediately removes your account, location, settings and
  sessions from the live database, and asks OneSignal to delete your record there.
- **"Clear My Location"** immediately removes your coordinates, district and street.
- The database keeps an automatic history for disaster recovery (Cloudflare D1 Time
  Travel). Deleted data stays in that history for **up to 7 days** and is then gone
  for good. We use the history only after an outage or a breach. If we ever have to
  restore the database, we delete again the data of any accounts deleted in the
  meantime.
- Server logs expire within 7 days.

## 7. Age

CityShield is only for people aged 18 and over. We do not knowingly collect data
from anyone younger. If we learn that an account belongs to someone under 18, we
delete it. A parent who thinks their child has an account can write to us.

## 8. Your rights

- **Access and portability:** Profile → Privacy & Data → Export My Data (a JSON
  file). For the data OneSignal holds, write to us.
- **Correction:** change your location in the app. To change your email, write to
  us.
- **Erasure:** Profile → Privacy & Data → Delete My Account; without the app at
  {{SITE_URL}}/delete-account; or by email.
- **Withdrawing location consent:** Profile → Privacy & Data → Clear My Location.
  Withdrawal does not affect the lawfulness of processing before it.
- **Objection and restriction:** you can object to processing based on legitimate
  interest (logs) or ask us to restrict processing. You switch alert categories off
  yourself in the Alerts tab.

We reply within one month. For a complex request this can be extended by two more
months, and we will tell you if it is. To make sure a request is really yours, we
may ask you to write from your account's email address.

You have the right to complain to Bulgaria's **Commission for Personal Data
Protection** (КЗЛД): 2 Prof. Tsvetan Lazarov Blvd., Sofia 1592,
<https://www.cpdp.bg>, kzld@cpdp.bg. You can also go to court.

## 9. Automated processing

The system works out automatically, including with an AI model, which places and
times each notice concerns and whom to alert. This is not a decision with legal or
similarly significant effects on you within the meaning of Art. 22 GDPR. We do no
profiling for advertising or any other purpose.

## 10. Security

The app talks to our server over HTTPS only. Passwords and sign-in keys are stored
only as hashes, sign-in attempts are rate-limited, and the database is stored in
the European Union. If a breach creates a high risk for you, we will tell you.

## 11. Changes to this policy

Every version has a number and a date. We will tell you about changes in the app. If
a change affects your location consent, we will ask for your consent again.
