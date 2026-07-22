// ─── src/i18n/translations.ts ────────────────────────────────────────────────
// English and Bulgarian string tables. Every key present in `en` must also be
// present in `bg` — enforced by the Record type below.
// Keys with a `{n}` / `{date}` placeholder are filled via String.replace.

const en = {
  // ── Common ──
  'common.cancel': 'Cancel',
  'common.loading': 'Loading…',
  'common.error': 'Error',
  'common.from': 'From',
  'common.until': 'Until',
  'common.retry': 'Try again',

  // ── API errors ──
  // Shown to users in place of raw server bodies / HTTP status text.
  'error.network': 'Could not reach CityShield. Check your connection and try again.',
  'error.rateLimited': 'Too many attempts. Please wait a moment and try again.',
  'error.session': 'Your session has expired. Please sign in again.',
  'error.duplicateEmail': 'An account with this email already exists.',
  'error.server': 'CityShield is having trouble right now. Please try again later.',
  'error.generic': 'Something went wrong. Please try again.',

  // ── Tab bar ──
  'tabs.home': 'Home',
  'tabs.alerts': 'Alerts',
  'tabs.profile': 'Profile',

  // ── Alert categories (shared: map chips, feed, notification inbox) ──
  'category.vik': 'Water (ВиК)',
  'category.vt': 'Traffic',
  'category.epro': 'Power (еПро)',
  'category.heating': 'Heating',
  'category.general': 'General',

  // ── Severity ──
  'severity.danger': 'DANGER',
  'severity.warning': 'WARNING',
  'severity.info': 'INFO',

  // ── Login screen ──
  'login.tagline': 'Protecting your community',
  'login.welcome': 'Welcome back',
  'login.subtitle': 'Sign in to your account',
  'login.emailLabel': 'Email Address',
  'login.passwordLabel': 'Password',
  'login.passwordPlaceholder': 'Enter your password',
  'login.signIn': 'Sign In',
  'login.or': 'OR',
  'login.createAccount': 'Create New Account',
  'login.footer': 'CityShield v1.0 · Secure & Encrypted',
  'login.errRequired': 'Please enter both email and password.',
  'login.failedTitle': 'Login Failed',
  'login.failedMsg': 'Invalid credentials.',
  'login.forgotLink': 'Forgot your password?',
  'login.forgotTitle': 'Reset password',
  'login.forgotNeedEmail': 'Enter your email address first, then tap again.',
  'login.forgotConfirm': 'Send a password reset link to {email}?',
  'login.forgotSend': 'Send link',
  'login.forgotSentTitle': 'Check your inbox',
  // Deliberately says nothing about whether the address is registered.
  'login.forgotSentMsg':
    'If an account exists for that address, a reset link is on its way. It is ' +
    'valid for one hour — check your spam folder if you do not see it.',

  // ── Register screen ──
  'register.headerTitle': 'Create Account',
  'register.headerSubtitle': "Join your city's protection network",
  'register.progressLabel': 'Account Details · Set Location',
  'register.sectionTitle': 'Account Details',
  'register.emailLabel': 'Email Address *',
  'register.emailPlaceholder': 'you@example.com',
  'register.passwordLabel': 'Password * (min. 8 characters)',
  'register.passwordPlaceholder': 'Create a strong password',
  'register.confirmLabel': 'Confirm Password *',
  'register.confirmPlaceholder': 'Re-enter your password',
  'register.locationHint':
    "After creating your account, you'll be prompted to set your location. " +
    'This lets CityShield send you alerts relevant to your area.',
  'register.submit': 'Create Account →',
  'register.haveAccount': 'Already have an account?',
  'register.signIn': 'Sign In',
  'register.validationTitle': 'Validation',
  'register.errRequired': 'Email and password are required.',
  'register.errMismatch': 'Passwords do not match.',
  'register.errTooShort': 'Password must be at least 8 characters.',
  'register.createdTitle': 'Account created',
  'register.createdMsg':
    'We sent a confirmation link to your email — open it so you can reset your ' +
    'password later if you need to. Sign in and set your location to start ' +
    'receiving alerts.',
  'register.failedTitle': 'Registration Failed',
  'register.failedMsg': 'Something went wrong.',

  // ── Home screen ──
  'home.noLocationTitle': 'Location not set',
  'home.noLocationSub':
    'Go to Profile → Set My Location to receive alerts for your area.',
  'home.goodMorning': 'Good morning,',
  'home.goodAfternoon': 'Good afternoon,',
  'home.goodEvening': 'Good evening,',
  'home.title': 'City Monitor',
  'home.systemActive': 'System Active',
  'home.statActive': 'Active Alerts',
  'home.statWarnings': 'Warnings',
  'home.statCritical': 'Critical',
  'home.alertMap': 'Alert Map',
  'home.collapse': 'Collapse',
  'home.expand': 'Expand',
  'home.legendCritical': 'Critical',
  'home.legendWarning': 'Warning',
  'home.legendInfo': 'Info',
  'home.filterAll': 'All',
  'home.alerts': 'Alerts',
  'home.activeSuffix': 'active',
  'home.tabRecent': 'Recent',
  'home.tabActive': 'Active',
  'home.loadingAlerts': 'Loading alerts…',
  'home.loadFailedTitle': 'Couldn’t load alerts',
  'home.allClear': 'All clear',
  'home.loadFailedSub':
    'The alert service is unreachable. Pull down to try again.',
  'home.emptyActiveSub': 'No alerts are active right now. Pull down to refresh.',
  'home.emptyRecentSub': 'No recent alerts for Varna. Pull down to refresh.',
  'home.tapCard': 'Tap a card to view details',
  'home.howItWorks': 'How it works',
  'home.howItWorksText':
    'Alerts from ВиК (water), еПро (power) and Веолия (heating) ' +
    'are scraped, AI-parsed, and geo-located on the map. ' +
    'VarnaTraffic route changes arrive as notifications and show up ' +
    'under Recent — pick your bus lines in Notifications → Categories.',
  'home.defaultAlertTitle': 'Alert',
  'home.justNow': 'Just now',
  'home.hoursAgo': '{n}h ago',
  'home.daysAgo': '{n}d ago',

  // ── Notifications screen ──
  'notif.title': 'Notifications',
  'notif.unread': '{n} unread',
  'notif.markAllRead': 'Mark all read',
  'notif.inbox': 'Inbox',
  'notif.categories': 'Categories',
  'notif.deleteTitle': 'Delete notification',
  'notif.deleteMsg': 'Remove this alert from your inbox?',
  'notif.delete': 'Delete',
  'notif.prefSaveFailed': 'Failed to save preference. Please try again.',
  'notif.busSaveFailed': 'Failed to save bus lines. Please try again.',
  'notif.settingsHint': 'Choose which types of city alerts you want to receive.',
  'notif.receiving': 'Receiving alerts',
  'notif.muted': 'Muted',
  'notif.busLines': 'Bus lines',
  'notif.allLines': 'All lines',
  'notif.line': 'Line {n}',
  'notif.pickerHint':
    'Pick the lines you ride to only get route changes that affect them. ' +
    'With no lines selected you receive every route change.',
  'notif.done': 'Done',
  'notif.prefLoadFailed': 'Could not load preferences. Check your connection.',
  'notif.unreadBadge': 'Unread',
  'notif.scheduledWindow': 'Scheduled window',
  'notif.received': 'Received {date}',
  'notif.markAsRead': 'Mark as read',
  'notif.close': 'Close',
  'notif.emptyTitle': 'No notifications yet',
  'notif.emptySub': 'Alerts for your area will appear here once they are issued.',

  // ── Profile screen ──
  'profile.bannerTitle': 'Location not set',
  'profile.bannerSub':
    'Set your location to start receiving alerts for your area.',
  'profile.activeMember': 'Active Member',

  'profile.sectionLanguage': 'Language',
  'profile.languageEnglish': 'English',
  'profile.languageBulgarian': 'Български',

  // ── Profile: appearance ──
  'profile.sectionAppearance': 'Appearance',
  'profile.themeSystem': 'System',
  'profile.themeSystemSub': 'Follow the device setting',
  'profile.themeLight': 'Light',
  'profile.themeDark': 'Dark',

  'profile.sectionLocation': 'Location',
  'profile.updateLocation': 'Update My Location',
  'profile.setLocation': 'Set My Location',
  'profile.locationSetSub': 'Coordinates are matched to your area via Nominatim',
  'profile.locationUnsetSub': 'Required to receive neighbourhood alerts',
  'profile.locationStatus': 'Location Status',
  'profile.locationSet': 'Location set',
  'profile.locationNotSet': 'Not set — no alerts will be sent',
  'profile.region': 'Neighbourhood / Region',
  'profile.street': 'Street',
  'profile.noStreet': 'No street match found',
  'profile.noRegion': 'No neighbourhood match found',

  'profile.sectionNotifications': 'Notifications',
  'profile.pushAlerts': 'Push Alerts',
  'profile.pushEnabled': 'Push notifications are enabled',
  'profile.pushTapToEnable': 'Tap to enable notifications',
  'profile.permDeniedTitle': 'Permission denied',
  'profile.permDeniedMsg':
    'Enable notifications in device Settings to receive alerts.',

  'profile.sectionAbout': 'About',
  'profile.email': 'Email',
  'profile.mapData': 'Map data',

  'profile.signOut': 'Sign Out',
  'profile.signOutConfirm': 'Are you sure you want to sign out?',
  'profile.footer': 'CityShield · Protecting Your Community',

  'profile.locationUpdatedTitle': 'Location updated',
  'profile.locationUpdatedMsg':
    'Your area has been set. You will now receive local alerts.',
  'profile.updateFailedTitle': 'Update Failed',
  'profile.noPinTitle': 'No pin placed',
  'profile.noPinMsg': 'Tap the map to place a pin on your location.',

  'profile.modalTitle': 'Set Location',
  'profile.modalSub':
    'Tap the map to place a pin on your location. Nominatim will detect ' +
    'your region and street.',
  'profile.modalPin': 'Pin',
  'profile.modalNoPin': 'No pin placed yet — tap the map',
  'profile.modalConfirm': 'Set Location',
  // Consent copy for the one third-country-ish transfer we make (PLAN.MD §2.2):
  // the coordinates leave for OSMF's Nominatim, so say so before the user taps.
  'profile.modalConsent':
    'By confirming, you consent to your coordinates being sent to ' +
    'OpenStreetMap’s Nominatim service to determine your district and street. ' +
    'The request carries no account identifier. Your location is stored only ' +
    'to match alerts to your area, and you can clear it at any time.',
  'profile.modalConsentLink': 'OpenStreetMap privacy policy',

  // ── Privacy & data (GDPR, PLAN.MD §1.10) ──
  'profile.sectionPrivacy': 'Privacy & Data',

  'profile.privacyPolicy': 'Privacy Policy',
  'profile.privacyPolicySub': 'What we store, why, and your rights',
  'profile.privacyPolicyFailed': 'Could not open the privacy policy.',

  'profile.exportData': 'Export My Data',
  'profile.exportDataSub': 'Download everything we store about you (JSON)',
  'profile.exportTitle': 'CityShield data export',
  'profile.exportFailed': 'Export Failed',

  'profile.clearLocation': 'Clear My Location',
  'profile.clearLocationSub': 'Withdraw location consent and stop local alerts',
  'profile.clearLocationConfirm':
    'Your coordinates, district and street will be deleted. You will keep ' +
    'receiving city-wide alerts only.',
  'profile.clearLocationDone': 'Location cleared',
  'profile.clearLocationDoneMsg': 'Your stored location has been deleted.',
  'profile.clearLocationFailed': 'Could not clear location',

  'profile.deleteAccount': 'Delete My Account',
  'profile.deleteAccountSub': 'Permanently erase your account and all data',
  'profile.deleteConfirm1':
    'This deletes your account, location, notification settings and devices. ' +
    'It cannot be undone.',
  'profile.deleteConfirm2Title': 'Delete permanently?',
  'profile.deleteConfirm2':
    'Last chance — your data will be erased immediately.',
  'profile.deleteContinue': 'Continue',
  'profile.deleteConfirmBtn': 'Delete',
  'profile.deleteDone': 'Account deleted',
  'profile.deleteDoneMsg': 'Your account and all associated data are gone.',
  'profile.deleteFailed': 'Could not delete account',

  // ── Email verification ──
  'profile.emailStatus': 'Email status',
  'profile.emailVerified': 'Confirmed',
  'profile.verifyPending': 'Confirm Your Email',
  'profile.verifyPendingSub': 'Tap to send the confirmation link again',
  'profile.verifySentTitle': 'Check your inbox',
  'profile.verifySentMsg':
    'If your address still needs confirming, a link is on its way. It is valid ' +
    'for 24 hours — check your spam folder if you do not see it.',
} as const;

export type TranslationKey = keyof typeof en;

const bg: Record<TranslationKey, string> = {
  // ── Общи ──
  'common.cancel': 'Отказ',
  'common.loading': 'Зареждане…',
  'common.error': 'Грешка',

  // ── Грешки от API ──
  'error.network': 'CityShield е недостъпен. Проверете връзката си и опитайте отново.',
  'error.rateLimited': 'Твърде много опити. Изчакайте малко и опитайте отново.',
  'error.session': 'Сесията ви изтече. Моля, влезте отново.',
  'error.duplicateEmail': 'Вече съществува акаунт с този имейл.',
  'error.server': 'CityShield има временен проблем. Опитайте отново по-късно.',
  'error.generic': 'Нещо се обърка. Моля, опитайте отново.',
  'common.from': 'От',
  'common.until': 'До',
  'common.retry': 'Опитай отново',

  // ── Долна лента ──
  'tabs.home': 'Начало',
  'tabs.alerts': 'Сигнали',
  'tabs.profile': 'Профил',

  // ── Категории сигнали ──
  'category.vik': 'Вода (ВиК)',
  'category.vt': 'Транспорт',
  'category.epro': 'Ток (еПро)',
  'category.heating': 'Парно',
  'category.general': 'Общи',

  // ── Сериозност ──
  'severity.danger': 'ОПАСНОСТ',
  'severity.warning': 'ПРЕДУПРЕЖДЕНИЕ',
  'severity.info': 'ИНФО',

  // ── Екран за вход ──
  'login.tagline': 'Защитаваме твоята общност',
  'login.welcome': 'Добре дошли отново',
  'login.subtitle': 'Влезте в акаунта си',
  'login.emailLabel': 'Имейл адрес',
  'login.passwordLabel': 'Парола',
  'login.passwordPlaceholder': 'Въведете паролата си',
  'login.signIn': 'Вход',
  'login.or': 'ИЛИ',
  'login.createAccount': 'Създай нов акаунт',
  'login.footer': 'CityShield v1.0 · Сигурно и криптирано',
  'login.errRequired': 'Моля, въведете имейл и парола.',
  'login.failedTitle': 'Неуспешен вход',
  'login.failedMsg': 'Невалидни данни за вход.',
  'login.forgotLink': 'Забравена парола?',
  'login.forgotTitle': 'Нова парола',
  'login.forgotNeedEmail': 'Първо въведете имейл адреса си, след което докоснете отново.',
  'login.forgotConfirm': 'Да изпратим ли връзка за нова парола до {email}?',
  'login.forgotSend': 'Изпрати връзка',
  'login.forgotSentTitle': 'Проверете пощата си',
  'login.forgotSentMsg':
    'Ако има профил с този адрес, изпратихме връзка за нова парола. Валидна е ' +
    'един час — проверете и папката със спам, ако не я виждате.',

  // ── Екран за регистрация ──
  'register.headerTitle': 'Създаване на акаунт',
  'register.headerSubtitle': 'Присъединете се към защитната мрежа на своя град',
  'register.progressLabel': 'Данни за акаунта · Задаване на локация',
  'register.sectionTitle': 'Данни за акаунта',
  'register.emailLabel': 'Имейл адрес *',
  'register.emailPlaceholder': 'ime@primer.bg',
  'register.passwordLabel': 'Парола * (мин. 8 символа)',
  'register.passwordPlaceholder': 'Създайте сигурна парола',
  'register.confirmLabel': 'Потвърдете паролата *',
  'register.confirmPlaceholder': 'Въведете паролата отново',
  'register.locationHint':
    'След създаване на акаунта ще бъдете подканени да зададете локацията си. ' +
    'Така CityShield ще ви изпраща сигнали за вашия район.',
  'register.submit': 'Създай акаунт →',
  'register.haveAccount': 'Вече имате акаунт?',
  'register.signIn': 'Вход',
  'register.validationTitle': 'Валидация',
  'register.errRequired': 'Имейлът и паролата са задължителни.',
  'register.errMismatch': 'Паролите не съвпадат.',
  'register.errTooShort': 'Паролата трябва да е поне 8 символа.',
  'register.createdTitle': 'Акаунтът е създаден',
  'register.createdMsg':
    'Изпратихме връзка за потвърждение на имейла ви — отворете я, за да можете ' +
    'по-късно да възстановите паролата си. Влезте и задайте локацията си, за да ' +
    'получавате сигнали.',
  'register.failedTitle': 'Неуспешна регистрация',
  'register.failedMsg': 'Нещо се обърка.',

  // ── Начален екран ──
  'home.noLocationTitle': 'Локацията не е зададена',
  'home.noLocationSub':
    'Отидете в Профил → Задай локацията ми, за да получавате сигнали за вашия район.',
  'home.goodMorning': 'Добро утро,',
  'home.goodAfternoon': 'Добър ден,',
  'home.goodEvening': 'Добър вечер,',
  'home.title': 'Градски монитор',
  'home.systemActive': 'Системата е активна',
  'home.statActive': 'Активни сигнали',
  'home.statWarnings': 'Предупреждения',
  'home.statCritical': 'Критични',
  'home.alertMap': 'Карта на сигналите',
  'home.collapse': 'Свий',
  'home.expand': 'Разгъни',
  'home.legendCritical': 'Критично',
  'home.legendWarning': 'Предупреждение',
  'home.legendInfo': 'Инфо',
  'home.filterAll': 'Всички',
  'home.alerts': 'Сигнали',
  'home.activeSuffix': 'активни',
  'home.tabRecent': 'Скорошни',
  'home.tabActive': 'Активни',
  'home.loadingAlerts': 'Зареждане на сигнали…',
  'home.loadFailedTitle': 'Сигналите не се заредиха',
  'home.allClear': 'Всичко е спокойно',
  'home.loadFailedSub':
    'Услугата за сигнали е недостъпна. Дръпнете надолу, за да опитате отново.',
  'home.emptyActiveSub':
    'В момента няма активни сигнали. Дръпнете надолу, за да обновите.',
  'home.emptyRecentSub':
    'Няма скорошни сигнали за Варна. Дръпнете надолу, за да обновите.',
  'home.tapCard': 'Докоснете карта, за да видите детайли',
  'home.howItWorks': 'Как работи',
  'home.howItWorksText':
    'Сигналите от ВиК (вода), еПро (ток) и Веолия (парно) се ' +
    'събират автоматично, обработват се с AI и се позиционират на картата. ' +
    'Промените в маршрутите от VarnaTraffic пристигат като известия и се ' +
    'показват в „Скорошни“ — изберете автобусните си линии от ' +
    'Известия → Категории.',
  'home.defaultAlertTitle': 'Сигнал',
  'home.justNow': 'Току-що',
  'home.hoursAgo': 'преди {n} ч',
  'home.daysAgo': 'преди {n} д',

  // ── Екран с известия ──
  'notif.title': 'Известия',
  'notif.unread': '{n} непрочетени',
  'notif.markAllRead': 'Прочети всички',
  'notif.inbox': 'Кутия',
  'notif.categories': 'Категории',
  'notif.deleteTitle': 'Изтриване на известие',
  'notif.deleteMsg': 'Да премахнем ли този сигнал от кутията ви?',
  'notif.delete': 'Изтрий',
  'notif.prefSaveFailed': 'Настройката не се запази. Моля, опитайте отново.',
  'notif.busSaveFailed': 'Автобусните линии не се запазиха. Моля, опитайте отново.',
  'notif.settingsHint': 'Изберете какви видове градски сигнали искате да получавате.',
  'notif.receiving': 'Получавате сигнали',
  'notif.muted': 'Заглушено',
  'notif.busLines': 'Автобусни линии',
  'notif.allLines': 'Всички линии',
  'notif.line': 'Линия {n}',
  'notif.pickerHint':
    'Изберете линиите, които ползвате, за да получавате само промени, ' +
    'които ги засягат. Без избрани линии получавате всички промени в маршрутите.',
  'notif.done': 'Готово',
  'notif.prefLoadFailed': 'Настройките не се заредиха. Проверете връзката си.',
  'notif.unreadBadge': 'Непрочетено',
  'notif.scheduledWindow': 'Планиран интервал',
  'notif.received': 'Получено на {date}',
  'notif.markAsRead': 'Маркирай като прочетено',
  'notif.close': 'Затвори',
  'notif.emptyTitle': 'Все още няма известия',
  'notif.emptySub': 'Сигналите за вашия район ще се появяват тук, когато бъдат издадени.',

  // ── Профил ──
  'profile.bannerTitle': 'Локацията не е зададена',
  'profile.bannerSub':
    'Задайте локацията си, за да получавате сигнали за вашия район.',
  'profile.activeMember': 'Активен потребител',

  'profile.sectionLanguage': 'Език',
  'profile.languageEnglish': 'English',
  'profile.languageBulgarian': 'Български',

  // ── Профил: изглед ──
  'profile.sectionAppearance': 'Изглед',
  'profile.themeSystem': 'Системен',
  'profile.themeSystemSub': 'Според настройката на устройството',
  'profile.themeLight': 'Светъл',
  'profile.themeDark': 'Тъмен',

  'profile.sectionLocation': 'Локация',
  'profile.updateLocation': 'Обнови локацията ми',
  'profile.setLocation': 'Задай локацията ми',
  'profile.locationSetSub':
    'Координатите се съпоставят с вашия район чрез Nominatim',
  'profile.locationUnsetSub': 'Необходимо за получаване на квартални сигнали',
  'profile.locationStatus': 'Статус на локацията',
  'profile.locationSet': 'Локацията е зададена',
  'profile.locationNotSet': 'Не е зададена — няма да получавате сигнали',
  'profile.region': 'Квартал / Район',
  'profile.street': 'Улица',
  'profile.noStreet': 'Няма намерена улица',
  'profile.noRegion': 'Няма намерен квартал',

  'profile.sectionNotifications': 'Известия',
  'profile.pushAlerts': 'Push известия',
  'profile.pushEnabled': 'Push известията са включени',
  'profile.pushTapToEnable': 'Докоснете, за да включите известията',
  'profile.permDeniedTitle': 'Отказано разрешение',
  'profile.permDeniedMsg':
    'Разрешете известията от настройките на устройството, за да получавате сигнали.',

  'profile.sectionAbout': 'Информация',
  'profile.email': 'Имейл',
  'profile.mapData': 'Картови данни',

  'profile.signOut': 'Изход',
  'profile.signOutConfirm': 'Сигурни ли сте, че искате да излезете?',
  'profile.footer': 'CityShield · Защитаваме твоята общност',

  'profile.locationUpdatedTitle': 'Локацията е обновена',
  'profile.locationUpdatedMsg':
    'Вашият район е зададен. Вече ще получавате местни сигнали.',
  'profile.updateFailedTitle': 'Неуспешно обновяване',
  'profile.noPinTitle': 'Няма поставена карфица',
  'profile.noPinMsg': 'Докоснете картата, за да поставите карфица на локацията си.',

  'profile.modalTitle': 'Задаване на локация',
  'profile.modalSub':
    'Докоснете картата, за да поставите карфица на локацията си. Nominatim ' +
    'ще определи района и улицата ви.',
  'profile.modalPin': 'Карфица',
  'profile.modalNoPin': 'Все още няма карфица — докоснете картата',
  'profile.modalConfirm': 'Задай локация',
  'profile.modalConsent':
    'С потвърждаването се съгласявате координатите ви да бъдат изпратени до ' +
    'услугата Nominatim на OpenStreetMap, за да се определят районът и улицата ви. ' +
    'Заявката не съдържа идентификатор на профила ви. Локацията се съхранява само ' +
    'за да получавате сигнали за вашия район и можете да я изтриете по всяко време.',
  'profile.modalConsentLink': 'Политика за поверителност на OpenStreetMap',

  // ── Поверителност и данни (GDPR) ──
  'profile.sectionPrivacy': 'Поверителност и данни',

  'profile.privacyPolicy': 'Политика за поверителност',
  'profile.privacyPolicySub': 'Какво съхраняваме, защо и какви са правата ви',
  'profile.privacyPolicyFailed': 'Политиката за поверителност не можа да се отвори.',

  'profile.exportData': 'Експорт на моите данни',
  'profile.exportDataSub': 'Изтеглете всичко, което съхраняваме за вас (JSON)',
  'profile.exportTitle': 'Експорт на данни от CityShield',
  'profile.exportFailed': 'Неуспешен експорт',

  'profile.clearLocation': 'Изтриване на локацията',
  'profile.clearLocationSub': 'Оттегляне на съгласието и спиране на местните сигнали',
  'profile.clearLocationConfirm':
    'Координатите, районът и улицата ви ще бъдат изтрити. Ще продължите да ' +
    'получавате само сигнали за целия град.',
  'profile.clearLocationDone': 'Локацията е изтрита',
  'profile.clearLocationDoneMsg': 'Съхранената ви локация беше изтрита.',
  'profile.clearLocationFailed': 'Локацията не можа да бъде изтрита',

  'profile.deleteAccount': 'Изтриване на профила',
  'profile.deleteAccountSub': 'Окончателно изтриване на профила и всички данни',
  'profile.deleteConfirm1':
    'Това изтрива профила, локацията, настройките за известия и устройствата ви. ' +
    'Действието е необратимо.',
  'profile.deleteConfirm2Title': 'Окончателно изтриване?',
  'profile.deleteConfirm2':
    'Последна възможност — данните ви ще бъдат изтрити незабавно.',
  'profile.deleteContinue': 'Продължи',
  'profile.deleteConfirmBtn': 'Изтрий',
  'profile.deleteDone': 'Профилът е изтрит',
  'profile.deleteDoneMsg': 'Профилът ви и всички свързани данни са премахнати.',
  'profile.deleteFailed': 'Профилът не можа да бъде изтрит',

  // ── Потвърждаване на имейл ──
  'profile.emailStatus': 'Състояние на имейла',
  'profile.emailVerified': 'Потвърден',
  'profile.verifyPending': 'Потвърдете имейла си',
  'profile.verifyPendingSub': 'Докоснете, за да изпратим връзката отново',
  'profile.verifySentTitle': 'Проверете пощата си',
  'profile.verifySentMsg':
    'Ако адресът ви все още не е потвърден, изпратихме връзка. Валидна е 24 часа — ' +
    'проверете и папката със спам, ако не я виждате.',
};

export const translations = {en, bg};
export type Language = keyof typeof translations;
