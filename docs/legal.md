# Legal research before the Play release

Research done on 26.10.2026 for the release. Work items are in [todo.md](todo.md) §8. The
GDPR record (Data Safety answers, DPIA reasoning, breach runbook) stays in
[compliance.md](compliance.md).

**This is research by a non-lawyer, not legal advice.** Wherever possible it quotes the
primary text: the Bulgarian law as published on lex.bg, the EDPB's own guidelines, and
Google's policy pages. Each claim says which kind of source it rests on:

- **[law]**: read in the statute or official text itself.
- **[guidance]**: an EDPB or regulator document.
- **[secondary]**: law-firm commentary or news; verify before relying on it.

§9 lists the questions to put to a Bulgarian lawyer.

---

## 1. Users under 18 — the decision that drives the rest

### 1.1 The age thresholds in Bulgarian law

| Age | What the law says | Source |
|---|---|---|
| under 14 (*малолетни*) | Cannot perform legal acts. Parents or guardians act *for* them, so the child cannot validly accept terms of use | ЗЛС чл. 3 [law] |
| 14–17 (*непълнолетни*) | Act **with the consent of their parents**, except "обикновени дребни сделки за задоволяване на текущите им нужди" (ordinary small transactions for everyday needs) | ЗЛС чл. 4 [law] |
| 18+ | Full capacity | ЗЛС чл. 2 [law] |
| under 14, data | Processing based on **consent** is lawful only if a parent gives it. This covers *any* consent-based processing, "включително" (including) information-society services. It is wider than GDPR Art. 8 | ЗЗЛД чл. 25в [law] |
| under 18 | A "child" for GDPR purposes, following the UN Convention on the Rights of the Child | EDPB Guidelines 05/2020 fn. 61 [guidance] |

Exact text of ЗЗЛД чл. 25в: *"Обработването на данни на субект на данни – лице,
ненавършило 14 години, въз основа на съгласие … включително в случаите на пряко
предлагане на услуги на информационното общество … е законосъобразно само ако
съгласието е дадено от упражняващия родителски права родител или от настойника."*

### 1.2 What that means for each thing CityShield stores

| Data | Lawful basis in `/privacy` | Under-14 user | 14–17 user |
|---|---|---|---|
| Email + password (the account) | Contract, Art. 6(1)(b) | No capacity to contract (ЗЛС чл. 3). Contract-based processing needs a *valid* contract (EDPB Guidelines 2/2019, [secondary]) | Needs parental consent unless a free notification account counts as an "ordinary small transaction". **Unclear: question for the lawyer** |
| Home coordinate | Consent, Art. 6(1)(a) | Parent must consent (ЗЗЛД чл. 25в) | The teenager can consent |
| Push registration | Contract | As for the account | As for the account |

### 1.3 Bulgaria makes a DPIA mandatory for services offered to children

The CPDP's list under Art. 35(4) GDPR (adopted 2019, filed with the EDPB) [law], item 7:

> "Processing of personal data of children in relation to the offer of information
> society services directly to a child."

So if CityShield is offered to under-18s, a **DPIA is not optional**. That reverses
compliance.md §2, which concluded no DPIA was needed. Item 3 on the same list (location
data used for profiling with legal or similarly significant effects) does **not** apply:
matching an outage to a home address is not profiling with legal effects.

The general test points the same way. WP248, the DPIA guidelines the CPDP list is built
on, says two criteria "in most cases" require a DPIA. A home location ("data of a
highly personal nature") combined with children ("vulnerable data subjects") is two
criteria [secondary summary of WP248].

### 1.4 How "offered directly to a child" is decided

EDPB Guidelines 05/2020 on consent [guidance]:

- **¶130:** if a provider "makes it clear to potential users that it is only offering its
  service to persons aged 18 or over", and nothing else undermines that (the content,
  the marketing plans), the service is **not** offered directly to a child, and Art. 8
  does not apply.
- **¶133:** if a user says they are old enough, the controller "can carry out
  appropriate checks", and is expected to, because a too-young user's consent is invalid.
- **¶135:** "Age verification should not lead to excessive data processing." In
  low-risk cases, a self-declaration or a year of birth can be enough.
- **¶144:** avoid verification "which themselves involve excessive collection of
  personal data". The EDPB's 2025 statement on age assurance [secondary] repeats this:
  collecting ID documents or birth dates to check age would itself be a violation of
  data minimisation for a low-risk app.

### 1.5 The options

| | **18+ only** | **14+** | **All ages** |
|---|---|---|---|
| ЗЗЛД чл. 25в (parent consents for under-14s) | Not triggered | Not triggered | Needs a parental-consent flow for location |
| Contract capacity (ЗЛС) | No issue | 14–17 need parental consent unless "ordinary small transaction" (lawyer) | Under-14s cannot contract at all |
| CPDP DPIA list item 7 | Not triggered (¶130) | **DPIA mandatory** | **DPIA mandatory** |
| Privacy policy | As is | Must be understandable to teenagers (Art. 12, Recital 58; EDPB ¶70) | Same, for children |
| Play | Target audience 18+ | 13–15 and 16–17 groups; not Families | Families policy if under-13s are included |
| US (if distributed there) | Safest | COPPA does not apply (it covers under-13s) | COPPA, if under-13s in the US |

**Recommendation: 18+ for the first release.** It is the only option that turns off
every child-specific obligation at once, and it costs a checkbox. Teenagers losing access
to outage notices is a real cost. It can be revisited later with a DPIA, a
teen-readable policy and a lawyer's view on ЗЛС чл. 4, none of which needs to block
version 1.

What 18+ requires in practice. ¶130 only holds if the 18+ statement is genuine and
nothing contradicts it:

1. "Only for people aged 18 and over" in the terms (§2), in `/privacy`, and at signup.
2. A **self-declaration checkbox** at registration ("Навършил/а съм 18 години"), stored
   with a timestamp, as in ¶135. Collect no birth date and no ID.
3. Play Console **target audience: 18+**. Nothing in the listing, screenshots or any
   promotion aimed at teenagers (no schools, no youth channels).
4. **A written procedure for actual knowledge:** when the operator learns that a user is
   under 18 (a complaint, a parent's email), delete the account and note it. This is
   also the COPPA standard (§1.6) and the EDPB ¶141 pattern.
5. Optional backstop: Play Console's **"Restrict minor access"** setting (also called
   "Restrict Declared Minors") stops Play users with a declared age under 18 from
   downloading the app. It is required only for gambling, dating and stranger-chat apps
   [secondary], but turning it on is cheap evidence that the 18+ statement is real.

### 1.6 Outside the EU

- **COPPA (US)** applies to foreign services "directed to children in the United
  States" or that "knowingly collect personal information from children" there (FTC
  letter to a foreign developer [secondary]). Age screening that does *not* exclude
  under-13s creates "actual knowledge" (the FTC's Yelp case [secondary]).
- **US state app-store laws:** Texas SB 2420, Utah (May 2026), Louisiana (July 2026)
  and California (Jan 2027) put age-category duties on app stores and developers.
  Texas was enjoined in Dec 2025, then made enforceable again by a Fifth Circuit stay
  in May 2026; the litigation is ongoing [secondary]. Google's Play Age Signals API is
  optional, and Google says compliance is the developer's responsibility [secondary].
- **What to do:** in Play Console, limit **countries/regions to Bulgaria** (or the EU).
  CityShield is useless outside Varna anyway, and this keeps US state law and COPPA out
  of scope.

---

## 2. Liability and the terms of use

- **Tort, ЗЗД чл. 45 [law]:** "Всеки е длъжен да поправи вредите, които виновно е причинил
  другиму. … вината се предполага до доказване на противното." **Fault is presumed.**
  If someone claims harm from a wrong or missed alert, the operator has to prove there
  was no fault, not the other way round. Good engineering records help here: the
  guards, the accuracy reviews, the incident log.
- **ЗЗД чл. 94 [law]:** clauses that exclude or limit liability in advance for **intent
  or gross negligence** are void. A disclaimer can limit ordinary negligence at most.
- **ЗЗП чл. 143 [law]**, if CityShield counts as a consumer contract:
  - ал. 2 т. 1: a clause excluding liability for death or injury is unfair.
  - ал. 2 т. 10: a clause the consumer could not read **before** concluding the contract
    is unfair. So the terms must be shown and accepted at signup, not just linked later.

  Whether a free hobby app's operator is a "търговец/доставчик" under ЗЗП is a question
  for the lawyer.
- **Digital content law:** Bulgaria transposed Directive 2019/770 in 2021 [secondary].
  Free services fall under it only where the user's personal data is used for more than
  supplying the service (Art. 3(1)). CityShield uses data only to supply the service,
  so it is probably outside [secondary, inference].

What the terms of use should say is listed in todo.md §8.1. The point of the list above
is that **a disclaimer reduces risk but cannot remove it**. Showing the source link on
every alert, and saying "automatically extracted, check the source", does more to stop
anyone *relying* on a wrong alert than any liability clause.

---

## 3. Republishing the four sources

### 3.1 Who runs them

| Source | Operator | Public or private | Terms found | robots.txt |
|---|---|---|---|---|
| vikvarna.com | „Водоснабдяване и канализация – Варна" ООД. 51% „Български ВиК холдинг" ЕАД (state), 35% Община Варна, the rest other municipalities [secondary: trade-register mirror] | **Public** | None found | None (404) |
| erpsever.bg | „Електроразпределение Север" АД | Private | Footer: "© 2026 Електроразпределение Север. Всички права запазени." Its "Общи условия" are customer terms, with nothing about website content | Disallows `/admin/`, `/product_offers/`, `/careers_apply/`; our XHR path is not disallowed |
| energy-varna.bg | Veolia Energy Varna, wholly owned by Veolia [secondary] | Private | Links to "Общи условия и правила за работа с клиенти" and Veolia's partner terms; neither read yet | Standard Drupal file; our paths are not disallowed |
| varnatraffic.com | **map.bg** (contact `support@map.bg`). The site says "Без общинско или европейско финансиране" | **Private.** The data shown comes from „Градски транспорт" ЕАД, which the municipality owns | None found | None (404) |

Correction: todo.md first said VarnaTraffic was "the municipality's". It is not. It is a
private site that republishes the municipal operator's data.

### 3.2 Copyright and database right

- **ЗАПСП чл. 4 [law, via a full-text copy]:** news, facts, information and data are not
  protected by copyright. The *facts* of an outage are free to use. The notification,
  though, pushes the source's **title and text verbatim** (`alert-service.ts`: `title`
  and `content` are scraped). Short factual notices are unlikely to meet the
  originality threshold, but verbatim copying is the weaker position. A summary built
  from the extracted fields, plus a link, would be the stronger one.
- **Database right** (Directive 96/9 Art. 7; ЗАПСП ch. 11a): it protects a database
  whose maker made a *substantial investment*, against extracting a substantial part,
  or repeatedly and systematically extracting insubstantial parts.
  - *CV-Online Latvia v Melons* (C‑762/19, 2021) [secondary]: infringement requires a
    risk to the maker's ability to recoup that investment. Public outage notices are
    not a product anyone sells, so the risk is low.
  - *Ryanair v PR Aviation* (C‑30/14, 2015): a site's own terms can restrict reuse by
    contract even where no IP right exists. **Not verified in this research.** It is the
    reason to read each site's terms anyway.
- **The scraper sends a Chrome user agent** (`scrape.ts`, `DEFAULT_HEADERS`) because
  some sources block non-browser agents. No robots.txt forbids our paths, so this is
  not a robots violation. But getting around a block is the worst look if an operator
  objects, and it is exactly what OSM's tile policy (§7) calls "spoofing".

**Recommendation:** email each operator (ViK, ERP Север, Veolia, map.bg) before
release. Say what the app does, that it links back, that it is free and unofficial, and
ask for a no-objection reply. Keep the replies. ViK and ERP Север have a public-service
interest in their notices spreading, so a yes is likely.

---

## 4. Google Play: government information and misleading claims

Google's "Requirements for apps that communicate government information" [Google policy
page], for apps **not** affiliated with a government:

- include "easy-to-see information sources" in the **description and store listing**;
- "make it clear that the app doesn't represent a government or political entity";
- sources "should let users easily verify the information".

The Misleading Claims policy bans falsely implying affiliation, and bans "Official" in a
title without the rights to it. ViK Варна is majority state-owned and its data is a
public utility's, so treat it as covered. The cost of being conservative is two
sentences in the listing.

---

## 5. Privacy policy and device storage

- **Controller identity (GDPR Art. 13(1)(a)):** the policy must name a real person or
  company. "The CityShield operator" is not enough.
- **ЗЕТ чл. 4 [law]:** an information-society service provider must give constant access
  to its name, permanent address, contact details (phone and email), and any register
  entry. ЗЕТ чл. 1 ал. 3 defines such services as ones that are "обикновено възмездни"
  (normally provided for remuneration). A free app with no revenue is arguably outside
  that, but the CJEU reads "remuneration" broadly, so this is a **question for the
  lawyer**. If it applies, the operator's address becomes public.
- **ЗЕТ чл. 4а [law]:** storing or reading information on the user's device requires
  Art. 13 information and a way to refuse. The exemption covers storage *necessary* for
  the service the user asked for (ал. 4). The app stores sign-in tokens, settings and
  notification history in AsyncStorage, and the OneSignal SDK keeps its subscription
  id; all of that is necessary. But `/privacy` says "не използваме бисквитки (услугата е
  само API)", which is true of the Worker and not of the app. Replace it with a short
  list of what the app keeps on the device.
- **OneSignal transfer mechanism:** OneSignal's documentation says it is certified under
  the EU‑US Data Privacy Framework, and its EU DPA attaches the SCCs [secondary].
  `/privacy` cites only SCCs. Check the DPF list and cite both.
- **If under-18s are ever admitted:** the policy has to be understandable to them
  (Art. 12(1), Recital 58, EDPB 05/2020 ¶70).

---

## 6. AI Act and DSA

- **AI Act Art. 50(4)** applies from 2 Aug 2026 [secondary]: a deployer publishing
  AI-generated text "to inform the public on matters of public interest" must disclose
  it, unless a human reviewed it with editorial responsibility. CityShield's push text
  is the source's own text; the model only picks places and times. That probably falls
  outside "AI-generated text", but the targeting *is* AI-made. Saying "places are
  detected automatically and may be wrong" in the terms and the app covers both the AI
  Act question and the liability one.
- **DSA:** it applies only to intermediary services: conduit, caching, hosting
  (Art. 2(2), Art. 3(g)). CityShield hosts no user content, so the DSA, including
  Art. 28 on minors, does not apply [secondary].

---

## 7. OpenStreetMap tile usage policy

From the OSMF tile usage policy [policy page]:

- **Identification:** apps must send "a distinct, stable User-Agent that names the app".
  Generic library defaults get blocked, and spoofing another app or browser is
  prohibited. The map WebViews (`leafletWebView.ts`) set no user agent, so tiles are
  requested with Android's default WebView agent. Fix: set
  `applicationNameForUserAgent` (for example `CityShield/1.0 (+contact)`) on both
  WebViews.
- **Attribution** must be shown clearly on the map. It is shown. Tapping it is blocked
  by `hardenedWebViewProps`, which is acceptable, but opening it in the external
  browser would be better.
- No offline use, no prefetching, honour cache headers. The app does none of the
  first two.
- Access is best-effort with no SLA and can be withdrawn without notice. That is the
  reason for the tile-provider plan in todo.md §9.1.

---

## 8. Already compliant, so not reopened

- In-app account deletion, data export and location withdrawal exist (GDPR Art. 15–17,
  20; Art. 7(3)).
- Cleartext is blocked in release builds, and `allowBackup="false"` is set.
- The app requests no location permission (the user picks a point on the map), so
  there is no sensitive-permission declaration.
- No ads and no analytics, so no ads declaration problems and no Families ad-SDK rules.

---

## 9. Questions for a Bulgarian lawyer

A one-hour consultation should cover:

1. With an 18+ self-declaration, is CityShield outside ЗЗЛД чл. 25в and CPDP DPIA list
   item 7 (EDPB ¶130)? If later opened to 14+, does a free notification account count
   as an "обикновена дребна сделка" under ЗЛС чл. 4?
2. Is a free, non-monetised app an "услуга на информационното общество" (ЗЕТ чл. 1
   ал. 3)? If so, must a natural-person operator publish a home address (ЗЕТ чл. 4)?
3. Does ЗЗП apply to a free hobby app, and so чл. 143?
4. Wording of the liability limitation in the terms, given ЗЗД чл. 45 (fault presumed)
   and чл. 94.
5. Is republishing the utilities' notice text **verbatim** acceptable, or should the app
   push a summary and a link? Is a no-objection email from each operator enough?
6. Natural person or company (ЕООД) as the controller and Play developer, given the
   liability exposure.

---

## Sources

Bulgarian law, read on lex.bg: [ЗЗЛД](https://lex.bg/laws/ldoc/2135426048) (чл. 25в),
[ЗЛС](https://lex.bg/laws/ldoc/2121624577) (чл. 2–4),
[ЗЗД](https://lex.bg/laws/ldoc/2121934337) (чл. 45, 94),
[ЗЗП](https://lex.bg/laws/ldoc/2135513678) (чл. 143),
[ЗЕТ](https://lex.bg/laws/ldoc/2135530547) (чл. 1, 4, 4а).
ЗАПСП чл. 4 via [trudipravo.bg](https://trudipravo.bg/znanie-za-vas/zakon-za-avtorskoto-pravo-i-srodnite-mu-prava).

Regulators: [CPDP DPIA list (EDPB register copy)](https://www.edpb.europa.eu/system/files/decisions/bg_list_dpia_operations_bulgaria_final.pdf);
[EDPB Guidelines 05/2020 on consent](https://gdpr-text.com/en/guidelines/consent/) §7.1;
[EDPB statement on age assurance (2025)](https://www.edpb.europa.eu/system/files/2025-04/edpb_statement_20250211ageassurance_v1-2_en.pdf);
[WP248 summary](https://www.scl.org/10311-when-to-conduct-dpias/).

Google Play: [Families / target audience](https://support.google.com/googleplay/android-developer/answer/9893335);
[government information](https://support.google.com/googleplay/android-developer/answer/9514050);
[account deletion](https://support.google.com/googleplay/android-developer/answer/13327111);
[Restrict Declared Minors](https://android-developers.googleblog.com/2024/12/build-high-quality-enagaing-age-appropriate-apps.html);
[Age Signals API](https://support.google.com/googleplay/android-developer/answer/16569691).

US: [Texas SB 2420 stay (Texas Tribune)](https://www.texastribune.org/2026/05/28/texas-apple-google-app-store-age-verification/);
[state app-store laws compared](https://natlawreview.com/article/app-store-age-verification-laws-your-questions-answered);
[FTC letter on foreign developers and COPPA](https://www.ftc.gov/system/files/documents/public_statements/606451/141222babybusletter.pdf).

Other: [OSMF tile usage policy](https://operations.osmfoundation.org/policies/tiles/);
[OneSignal DPF](https://documentation.onesignal.com/docs/eu-us-data-privacy-framework);
[AI Act Art. 50 guide](https://artificialintelligenceact.eu/transparency-rules-article-50/);
[DSA Art. 3](https://prighter.com/resources/laws/dsa/articles/article-3);
[CV-Online Latvia (Bird & Bird)](https://www.twobirds.com/en/insights/2021/uk/cv-online-latvia-cjeu-complicates-the-enforcement-of-database-rights);
[ViK Варна shareholders (papagal.bg)](https://papagal.bg/eik/103002253/3d6a).
