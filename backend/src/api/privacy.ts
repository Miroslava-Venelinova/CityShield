// Privacy policy served by the Worker itself at /privacy (PLAN.MD §1.10,
// content checklist §2.5). Linked from the app and the Play Store listing.
// Controller contact below is cityshield.varna@gmail.com, confirmed by the
// operator 2026-07-21; it must stay in sync with COMPLIANCE.md.

import { Hono } from "hono";
import type { AppEnv } from "./middleware";

const POLICY_HTML = `<!doctype html>
<html lang="bg">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>CityShield — Политика за поверителност / Privacy Policy</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 46rem; margin: 2rem auto; padding: 0 1rem; line-height: 1.6; color: #222; }
  h1 { font-size: 1.5rem; } h2 { font-size: 1.2rem; margin-top: 2rem; }
  table { border-collapse: collapse; width: 100%; font-size: 0.9rem; }
  th, td { border: 1px solid #ccc; padding: 0.4rem 0.6rem; text-align: left; vertical-align: top; }
  .en { color: #444; }
  hr { margin: 3rem 0; }
</style>
</head>
<body>

<h1>Политика за поверителност на CityShield</h1>
<p><em>Последна редакция: 19 юли 2026 г.</em></p>

<p>CityShield е мобилно приложение, което известява жителите на Варна за аварии
и прекъсвания (вода, ток, парно, градски транспорт). Администратор на
личните данни е операторът на CityShield — свържете се с нас на
<a href="mailto:cityshield.varna@gmail.com">cityshield.varna@gmail.com</a>.</p>

<h2>Какви данни съхраняваме и защо</h2>
<table>
<tr><th>Данни</th><th>Цел</th><th>Правно основание</th><th>Срок</th></tr>
<tr><td>Имейл адрес и хеширана парола</td><td>Профил и вход</td><td>Договор (чл. 6(1)(б) ОРЗД)</td><td>До изтриване на профила</td></tr>
<tr><td>Точни координати + квартал/улица</td><td>Известия за вашия район</td><td>Съгласие (чл. 6(1)(а)) — задавате местоположение само по ваш избор</td><td>До промяна, изчистване или изтриване</td></tr>
<tr><td>Токени за известия (FCM), вид устройство</td><td>Изпращане на известия</td><td>Договор</td><td>60 дни след последна активност или при изход/изтриване</td></tr>
<tr><td>Настройки за известия и абонаменти за линии</td><td>Функционалност</td><td>Договор</td><td>До изтриване на профила</td></tr>
<tr><td>Сървърни логове (IP, заявки)</td><td>Сигурност и отстраняване на проблеми</td><td>Легитимен интерес (чл. 6(1)(е))</td><td>Няколко дни (Cloudflare)</td></tr>
</table>
<p>Не събираме имена, телефони, реклами или проследяване. Съобщенията за аварии
са публична информация от операторите на комунални услуги и не са лични данни;
пазят се 90 дни.</p>

<h2>Обработващи лични данни</h2>
<ul>
<li><strong>Cloudflare</strong> (хостинг, база данни в Западна Европа) — по Споразумение за обработка на данни; сертифициран по EU-US Data Privacy Framework.</li>
<li><strong>Google Firebase Cloud Messaging</strong> — доставка на известия; по Условията за обработка на данни на Google.</li>
<li><strong>OpenStreetMap Nominatim</strong> — при задаване на местоположение вашите координати се изпращат до услугата Nominatim на OpenStreetMap Foundation, за да се определи кварталът/улицата. Заявката не съдържа ваш идентификатор. Вижте <a href="https://osmfoundation.org/wiki/Privacy_Policy">политиката на OSMF</a>.</li>
</ul>

<h2>Вашите права</h2>
<ul>
<li><strong>Достъп и преносимост</strong> — профилът и експортът на данни са достъпни в приложението (или през API: GET /api/auth/me/export).</li>
<li><strong>Коригиране</strong> — местоположението може да се зададе наново по всяко време.</li>
<li><strong>Изтриване</strong> — бутон „Изтрий профила" в настройките изтрива всички ваши данни незабавно.</li>
<li><strong>Оттегляне на съгласие</strong> — местоположението може да бъде изчистено от настройките.</li>
<li><strong>Възражение/ограничаване</strong> — известията по категории се изключват от настройките; за друго ни пишете.</li>
<li><strong>Жалба</strong> — имате право да подадете жалба до Комисията за защита на личните данни (<a href="https://www.cpdp.bg">cpdp.bg</a>).</li>
</ul>

<p>Не извършваме автоматизирано вземане на решения с правни последици, не
продаваме данни и не използваме бисквитки (услугата е само API).</p>

<hr>

<div class="en">
<h1>CityShield Privacy Policy (English)</h1>
<p><em>Last revised: 19 July 2026</em></p>

<p>CityShield is a mobile app that notifies residents of Varna, Bulgaria about
utility outages (water, power, heating, public transport). The data
controller is the CityShield operator — contact
<a href="mailto:cityshield.varna@gmail.com">cityshield.varna@gmail.com</a>.</p>

<h2>What we store and why</h2>
<table>
<tr><th>Data</th><th>Purpose</th><th>Lawful basis</th><th>Retention</th></tr>
<tr><td>Email + hashed password</td><td>Account/sign-in</td><td>Contract (Art. 6(1)(b) GDPR)</td><td>Until account deletion</td></tr>
<tr><td>Precise coordinates + district/street</td><td>Location-matched alerts</td><td>Consent (Art. 6(1)(a)) — location is optional and user-initiated</td><td>Until changed, cleared or deleted</td></tr>
<tr><td>Push tokens (FCM), device type</td><td>Notification delivery</td><td>Contract</td><td>60 days after last activity, or on logout/deletion</td></tr>
<tr><td>Notification preferences, bus-line subscriptions</td><td>App functionality</td><td>Contract</td><td>Until account deletion</td></tr>
<tr><td>Server logs (IP, requests)</td><td>Security/debugging</td><td>Legitimate interest (Art. 6(1)(f))</td><td>A few days (Cloudflare)</td></tr>
</table>
<p>We collect no names, phone numbers, ads or tracking. Outage alerts are
public utility announcements, not personal data; kept for 90 days.</p>

<h2>Processors</h2>
<ul>
<li><strong>Cloudflare</strong> (hosting; database at rest in Western Europe) — under its Data Processing Addendum; EU-US Data Privacy Framework certified.</li>
<li><strong>Google Firebase Cloud Messaging</strong> — push delivery; under Google's Data Processing Terms.</li>
<li><strong>OpenStreetMap Nominatim</strong> — when you set your location, your coordinates are sent to the OpenStreetMap Foundation's Nominatim service to determine your district/street. The request carries no user identifier. See the <a href="https://osmfoundation.org/wiki/Privacy_Policy">OSMF privacy policy</a>.</li>
</ul>

<h2>Your rights</h2>
<ul>
<li><strong>Access & portability</strong> — profile and data export in-app (or via API: GET /api/auth/me/export).</li>
<li><strong>Rectification</strong> — location can be re-set at any time.</li>
<li><strong>Erasure</strong> — the "Delete account" button in settings removes all your data immediately.</li>
<li><strong>Withdraw consent</strong> — location can be cleared from settings.</li>
<li><strong>Objection/restriction</strong> — per-category notification toggles in settings; contact us for anything else.</li>
<li><strong>Complaint</strong> — you may lodge a complaint with Bulgaria's Commission for Personal Data Protection (<a href="https://www.cpdp.bg">cpdp.bg</a>).</li>
</ul>

<p>No automated decision-making with legal effects, no sale of data, no cookies
(the service is API-only).</p>

<p>Map data © OpenStreetMap contributors. Geocoding by Nominatim, street
geometry via Overpass API.</p>
</div>

</body>
</html>`;

export const privacyRoutes = new Hono<AppEnv>()
  .get("/", (c) => c.html(POLICY_HTML));
