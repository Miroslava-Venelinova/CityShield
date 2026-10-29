# About screen and licences

Text for an "About" screen opened from Profile → About (today that section shows only
the email, a hard-coded "v1.0.0" and "© OpenStreetMap"). Bulgarian is the binding
text; the English is a translation. Runtime values are in `{{...}}`.

## 1. About text

**BG**

> **CityShield** {{APP_VERSION}}
>
> Известия за аварии и прекъсвания на вода, ток, парно и градски транспорт във
> Варна и областта.
>
> CityShield е неофициално приложение. Не е свързано с дружествата по-долу, с
> Община Варна или с друг държавен орган. Сигналите се взимат автоматично от
> сайтовете им и се показват дословно. Местата се разпознават автоматично и може да
> са грешни. За важни неща проверявайте в източника.
>
> **Източници**
> - Вода: „Водоснабдяване и канализация – Варна" ООД, vikvarna.com
> - Ток: „Електроразпределение Север" АД, erpsever.bg
> - Парно: Веолия Енерджи Варна, energy-varna.bg
> - Градски транспорт: VarnaTraffic (map.bg), varnatraffic.com, с данни от
>   „Градски транспорт" ЕАД
>
> **Карти и данни за места**
> - Картографски данни © сътрудниците на OpenStreetMap, по лиценз Open Database
>   License (ODbL): openstreetmap.org/copyright
> - Данните за населени места, квартали и улици, по които CityShield разпознава
>   местата, са извлечени от OpenStreetMap и се използват по лиценз ODbL.
> - Изображенията на картата идват от сървърите на OpenStreetMap Foundation.
> - Адресът по зададената точка се определя с Nominatim (OpenStreetMap Foundation).
> - Картата се показва с Leaflet, © Volodymyr Agafonkin и CloudMade, лиценз BSD
>   2-Clause.
>
> **Документи**
> - Общи условия (приети версия {{ACCEPTED_TERMS_VERSION}})
> - Политика за поверителност
> - Лицензи на софтуера с отворен код
>
> Контакт: cityshield.varna@gmail.com

**EN**

> **CityShield** {{APP_VERSION}}
>
> Alerts about water, power, heating and public transport outages in Varna and the
> surrounding area.
>
> CityShield is an unofficial app. It is not affiliated with the companies below,
> with Varna Municipality or with any other public authority. Alerts are taken
> automatically from their websites and shown word for word. Places are detected
> automatically and may be wrong. For anything important, check the source.
>
> **Sources**
> - Water: „Водоснабдяване и канализация – Варна" ООД (ViK Varna), vikvarna.com
> - Power: „Електроразпределение Север" АД (ERP Sever), erpsever.bg
> - Heating: Veolia Energy Varna, energy-varna.bg
> - Public transport: VarnaTraffic (map.bg), varnatraffic.com, with data from
>   „Градски транспорт" ЕАД
>
> **Maps and place data**
> - Map data © OpenStreetMap contributors, under the Open Database License (ODbL):
>   openstreetmap.org/copyright
> - The settlement, district and street data CityShield uses to recognise places is
>   derived from OpenStreetMap and used under the ODbL.
> - Map images come from the OpenStreetMap Foundation's tile servers.
> - The address for the point you set is found with Nominatim (OpenStreetMap
>   Foundation).
> - The map is drawn with Leaflet, © Volodymyr Agafonkin and CloudMade, BSD 2-Clause
>   licence.
>
> **Documents**
> - Terms of Use (accepted version {{ACCEPTED_TERMS_VERSION}})
> - Privacy Policy
> - Open-source licences
>
> Contact: cityshield.varna@gmail.com

All links open in the external browser, not in a WebView.

## 2. Open-source licences screen

The list is **generated at build time**, never written by hand, so it cannot fall
behind the dependencies. Screen title: „Лицензи на софтуера с отворен код" / "Open-source
licences". Intro line:

> BG: CityShield използва следния софтуер с отворен код. За всеки пакет са дадени
> авторите и пълният текст на лиценза му.
>
> EN: CityShield uses the following open-source software. Each package lists its
> authors and the full text of its licence.

Then `{{LICENCES_LIST}}`: one entry per package with name, version, licence name,
copyright line and full licence text.

What the generator has to cover:

- **npm packages** shipped in the bundle: the production dependency tree of
  `frontend/package.json`, transitively (React Native, React, React Navigation,
  react-native-onesignal, react-native-webview, react-native-svg and the rest). Not
  devDependencies.
- **Native Android libraries** pulled in by Gradle (the OneSignal and Firebase
  Messaging SDKs, AndroidX). They are not in `package.json`, so an npm-only tool
  misses them; a Gradle licence plugin covers them.
- **Leaflet**, if it is vendored as a file rather than installed from npm: add its
  `LICENSE` by hand, because no generator will see it.
- **Fonts and icon sets** bundled by `react-native-vector-icons`, which carry their
  own licences.

The Worker's dependencies (`hono`, `zod`, `jsts`) run on our server and are not
distributed to users, so they do not need to appear here.
