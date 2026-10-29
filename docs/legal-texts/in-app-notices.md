# In-app notices and store text

Short strings for the app and the Play listing. Bulgarian is the binding text; the
English is a translation. Suggested translation keys are given for
`frontend/src/i18n/translations.ts`. Runtime values are in `{{...}}`; see README.md.

## 1. First-launch notice

Shown once, before sign-in, as a full-screen notice with one button. Store a
"seen" flag on the device (it is already listed in the privacy policy, §4).

| Key | BG | EN |
|---|---|---|
| `notice.firstLaunchTitle` | Преди да започнете | Before you start |
| `notice.firstLaunchBody` | CityShield е неофициално приложение. Не е свързано с ВиК Варна, ЕРП Север, Веолия Енерджи Варна, VarnaTraffic или Община Варна. Сигналите се взимат автоматично от сайтовете им и се показват дословно. Местата се разпознават автоматично и може да са грешни, а сигнал може да закъснее или да не пристигне. За важни неща проверявайте източника. При опасност звънете на 112. | CityShield is an unofficial app. It is not affiliated with ViK Varna, ERP Sever, Veolia Energy Varna, VarnaTraffic or Varna Municipality. Alerts are taken automatically from their websites and shown word for word. Places are detected automatically and may be wrong, and an alert may be late or not arrive. For anything important, check the source. In an emergency call 112. |
| `notice.firstLaunchOk` | Разбрах | I understand |

## 2. Alert detail line

Shown on every alert's detail sheet (`HomeScreen` bottom sheet), under the text,
with the link as a separate tappable row that opens the external browser.

| Key | BG | EN |
|---|---|---|
| `alert.disclaimer` | Неофициално. Текстът е на {{SOURCE_NAME}} и е показан дословно. Местата са разпознати автоматично и може да са грешни. Проверете в източника. | Unofficial. The text is by {{SOURCE_NAME}} and is shown word for word. Places were detected automatically and may be wrong. Check the source. |
| `alert.openSource` | Отвори оригиналното съобщение | Open the original notice |

`{{SOURCE_NAME}}` per category, to replace today's category labels wherever the
issuer is named:

| Category | BG | EN |
|---|---|---|
| `vik` | ВиК Варна | ViK Varna |
| `epro` | ЕРП Север | ERP Sever |
| `heating` | Веолия Енерджи Варна | Veolia Energy Varna |
| `vt` | VarnaTraffic (map.bg) | VarnaTraffic (map.bg) |

## 3. Sign-up checkboxes

Both boxes start unticked, both are required, and "Create Account" stays disabled
until both are ticked. The two links open the full texts **before** sign-up (ЗЗП
чл. 143 ал. 2 т. 10). Send the accepted terms version with the registration request
and store it with a timestamp.

| Key | BG | EN |
|---|---|---|
| `register.acceptTerms` | Приемам [Общите условия]. Прочетох [Политиката за поверителност]. | I accept the [Terms of Use]. I have read the [Privacy Policy]. |
| `register.ageConfirm` | Навършил/а съм 18 години. | I am 18 or older. |
| `register.consentNote` | Записваме кога сте отметнали тези полета и коя версия на условията сте приели. | We record when you ticked these boxes and which version of the terms you accepted. |
| `register.errTerms` | За да създадете профил, трябва да приемете Общите условия. | You need to accept the Terms of Use to create an account. |
| `register.errAge` | CityShield е само за лица, навършили 18 години. | CityShield is only for people aged 18 and over. |

The privacy policy is something to read, not to accept, which is why the first box
says "прочетох / I have read" for it.

## 4. Location consent

Location is set after sign-up, in the "Set Location" sheet, so the consent wording
belongs there and replaces `profile.modalConsent`. It must stay **optional**: the app
works without a location (city-wide alerts), so it cannot be a condition for creating
an account. Tapping "Set Location" after this text is the consent. Store the
timestamp and policy version when it is given.

| Key | BG | EN |
|---|---|---|
| `profile.modalConsent` | С „Задай локация" се съгласявате да пазим избраната точка и определените по нея квартал и улица, за да ви изпращаме сигнали за района ви. За да ги определим, нашият сървър изпраща координатите до услугата Nominatim на OpenStreetMap, без данни за профила ви. Записваме кога сте се съгласили и към коя версия на Политиката за поверителност. Можете да оттеглите съгласието си по всяко време с „Изтриване на локацията". | By tapping "Set Location" you agree that we store the point you picked, and the district and street worked out from it, to send you alerts for your area. To work them out, our server sends the coordinates to OpenStreetMap's Nominatim service, without any account data. We record when you agreed and to which version of the Privacy Policy. You can withdraw consent at any time with "Clear My Location". |
| `profile.modalConsentLink` | Политика за поверителност | Privacy Policy |

If the owner prefers a checkbox in the same sheet (not pre-ticked):
"Съгласен/на съм CityShield да пази избраната от мен точка, за да ми изпраща
сигнали за района ми." / "I agree that CityShield stores the point I picked to send
me alerts for my area."

## 5. Changed terms

Shown at launch when the accepted terms version is older than the current one and
the change is marked significant.

| Key | BG | EN |
|---|---|---|
| `notice.termsChangedTitle` | Общите условия са променени | The Terms of Use have changed |
| `notice.termsChangedBody` | Прегледайте новата версия. За да продължите, приемете я. Ако не сте съгласни, можете да изтриете профила си от Профил → Поверителност и данни. | Please review the new version and accept it to continue. If you do not agree, you can delete your account under Profile → Privacy & Data. |
| `notice.termsChangedAccept` | Приемам | I accept |

## 6. Corrections to existing strings

These say something the privacy policy no longer says.

| Key | Today (EN) | Replace with (BG / EN) |
|---|---|---|
| `profile.deleteConfirm2` | "Last chance — your data will be erased immediately." | Последна възможност. Данните ви се изтриват веднага, а от резервните копия до 7 дни. / Last chance. Your data is erased now, and from backups within 7 days. |
| `profile.deleteDoneMsg` | "Your account and all associated data are gone." | Профилът ви е изтрит. Резервните копия изчезват до 7 дни. / Your account has been deleted. Backups expire within 7 days. |
| `home.howItWorksText` | "Alerts from ВиК (water), еПро (power) and Веолия (heating) are scraped, AI-parsed…" | Name ЕРП Север, not "еПро", and add: "CityShield е неофициално приложение." / "CityShield is an unofficial app." |
| `category.epro` | "Power (еПро)" | Ток (ЕРП Север) / Power (ERP Sever) |

## 7. Play Store full description: sources and non-affiliation

Put this paragraph in the full description of each locale, near the top. Never use
"Official" / "Официален" anywhere in the listing.

**BG**

> CityShield е неофициално приложение. То не е свързано с „Водоснабдяване и
> канализация – Варна" ООД, „Електроразпределение Север" АД, Веолия Енерджи Варна,
> VarnaTraffic (map.bg), „Градски транспорт" ЕАД, Община Варна или друг държавен
> орган и не ги представлява. Сигналите се взимат от публичните съобщения на
> vikvarna.com, erpsever.bg, energy-varna.bg и varnatraffic.com и се показват
> дословно, с връзка към оригинала. Местата се разпознават автоматично и може да са
> грешни. За важни неща проверявайте в източника.

**EN**

> CityShield is an unofficial app. It is not affiliated with ViK Varna, ERP Sever,
> Veolia Energy Varna, VarnaTraffic (map.bg), Varna's public transport company
> („Градски транспорт" ЕАД), Varna Municipality or any other public authority, and
> does not represent them. Alerts are taken from the public notices on
> vikvarna.com, erpsever.bg, energy-varna.bg and varnatraffic.com and shown word for
> word, with a link to the original. Places are detected automatically and may be
> wrong. For anything important, check the source.
