// =====================================================================
// FREEDOM — PWA: УСТАНОВКА, ОБНОВЛЕНИЕ И УДАЛЕНИЕ ПРИЛОЖЕНИЯ
// =====================================================================
// Что здесь происходит:
//   1) регистрируем service worker (sw.js) — без него браузер не предложит
//      «Установить приложение», и приложение не откроется без сети;
//   2) ловим событие браузера beforeinstallprompt: это единственный способ
//      дать кнопку «Установить». Пока события нет, установить кнопкой нельзя
//      (на iPhone Safari его нет вовсе — там шаги «Поделиться» → «На экран
//      „Домой“»);
//   3) показываем карточку «Установить FreeDOM» (#pwa-install-banner) — один
//      раз и только там, где установка доступна;
//   4) когда service worker скачал новую версию, предлагаем «Обновить»
//      (#pwa-update-banner): иначе сотрудник останется на старых файлах;
//   5) рисуем раздел «Приложение» в настройках (renderAppSection()): состояние
//      «установлено / не установлено», кнопку установки, кнопку обновления и
//      кнопку удаления.
//
// ПОЧЕМУ УСТАНОВКА ПЕРЕЕХАЛА В НАСТРОЙКИ (v2.12.0-r8). Раньше установка была
// отдельным пунктом меню «📲 Установить приложение», а обновление — только в
// карточке внизу. Сотрудник с уже установленным приложением не находил ни
// того, ни другого: предлагать установку нечего, а про обновление он узнавал
// лишь из карточки. Теперь состояние и обе кнопки — в одном месте: у
// установленного приложения кнопки установки нет, зато есть «Обновить» и
// «Удалить».
//
// ПОЧЕМУ «УДАЛИТЬ» — КНОПКА, А НЕ ФУНКЦИЯ БРАУЗЕРА. У веб-приложений нет API
// «удали себя»: ярлык и запись в системе убирает само устройство. Поэтому
// кнопка делает свою часть — снимает кэш оболочки и service worker, — а шаги
// для ярлыка показывает в окне подтверждения (#pwa-uninstall-modal). Данные в
// облаке при этом не трогаются.
//
// КАК УЗНАЁМ, ЧТО ПРИЛОЖЕНИЕ УСТАНОВЛЕНО: приложение открыто отдельным окном
// (display-mode: standalone), в этом сеансе сработало событие appinstalled либо
// браузер сам ответил на navigator.getInstalledRelatedApps() (манифест
// перечисляет приложение в related_applications, см. manifest.json). Safari и
// Firefox этот вопрос задать нельзя — там остаются первые два признака.
//
// Разметка карточек, раздела настроек и окна удаления — в index.html, тексты —
// в словаре (data-i18n), поэтому формулировки модуль не дублирует.
// =====================================================================

import { CONFIG } from './config.js';
import { log, toast, hideModal, showModal } from './utils.js';
import { t } from './i18n.js';

const OFFER_KEY = 'rsk.pwa.install';       // 'no' — от установки отказались навсегда
const SNOOZE_KEY = 'rsk.pwa.snooze';       // 'yes' — «Позже» до конца сеанса
const INSTALLED_KEY = 'rsk.pwa.installed'; // 'yes' — приложение стоит на этом устройстве

// Имя кэша оболочки — `freedom-v<версия>-<ревизия>` (см. sw.js). Ревизию
// показываем сотруднику: по ней Администратор видит, свежие ли файлы у
// человека (то же значение уходит в журнал ошибок, js/monitoring.js).
const CACHE_PREFIX = 'freedom';
const LEGACY_CACHE_PREFIX = 'rsk-odessa';

let installPrompt = null;       // сохранённое событие beforeinstallprompt
let installBannerReady = false; // есть что показать про установку
let updateBannerReady = false;  // есть скачанная новая версия
let updateRequested = false;    // нажали «Обновить» → перезагружаемся по controllerchange
let installedKnown = null;      // ответ браузера на «приложение установлено?»
let updateBusy = false;         // идёт проверка обновления из настроек

// =====================================================================
// ТОЧКА ВХОДА (вызывается из boot() в js/main.js)
// =====================================================================

export function initPWA() {
    registerServiceWorker();
    watchInstallPrompt();
    watchAppContainer();
}

// =====================================================================
// SERVICE WORKER
// =====================================================================

function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;   // старый браузер — работаем как раньше

    if (!window.isSecureContext) {
        // http:// (кроме localhost) — браузер запрещает и установку, и кэш
        log.info('PWA: нужен HTTPS или localhost — установка приложения недоступна');
        return;
    }

    navigator.serviceWorker.register('./sw.js')
        .then((registration) => {
            log.info(`PWA: service worker v${CONFIG.APP.VERSION} зарегистрирован (${registration.scope})`);
            watchForUpdate(registration);
            registration.update().catch(() => {});   // проверяем обновление при каждом запуске
        })
        .catch((error) => log.warn('PWA: не удалось зарегистрировать service worker', error));

    navigator.serviceWorker.addEventListener('controllerchange', () => {
        // перезагружаемся только по кнопке «Обновить», иначе рискуем циклами
        if (updateRequested) window.location.reload();
    });
}

function watchForUpdate(registration) {
    // Новая версия уже скачана и ждёт активации
    if (registration.waiting && navigator.serviceWorker.controller) {
        updateBannerReady = true;
        showBanners();
        refreshAppSection();
    }

    registration.addEventListener('updatefound', () => {
        const installing = registration.installing;
        if (!installing) return;
        installing.addEventListener('statechange', () => {
            // controller есть только у уже установленного приложения:
            // при первой установке предлагать «Обновить» не нужно
            if (installing.state === 'installed' && navigator.serviceWorker.controller) {
                log.info('PWA: скачана новая версия приложения');
                updateBannerReady = true;
                showBanners();
                refreshAppSection();
            }
        });
    });
}

// =====================================================================
// УСТАНОВКА: СОБЫТИЕ БРАУЗЕРА И КАРТОЧКА
// =====================================================================

/**
 * Ловим событие браузера «установка доступна». Оно же — единственный способ
 * дать кнопку «Установить»: без события кнопки нет, а в настройках остаются
 * шаги установки для своего устройства.
 */
function watchInstallPrompt() {
    window.addEventListener('beforeinstallprompt', (event) => {
        event.preventDefault();       // не показываем системную плашку — покажем свою
        installPrompt = event;
        if (bannerAllowed()) {
            installBannerReady = true;
            showBanners();
        }
        refreshAppSection();          // настройки могли быть открыты до события
    });

    window.addEventListener('appinstalled', () => {
        log.info('PWA: приложение установлено');
        installPrompt = null;
        installBannerReady = false;
        installedKnown = true;
        localStorage.setItem(OFFER_KEY, 'no');        // больше установку не предлагаем
        localStorage.setItem(INSTALLED_KEY, 'yes');   // приложение стоит на этом устройстве
        hide('pwa-install-banner');
        hideModal('pwa-uninstall-modal');
        refreshAppSection();
    });

    // iPhone и iPad: beforeinstallprompt не приходит, установка — вручную через
    // «Поделиться». Карточка объясняет шаги вместо кнопки.
    if (isIOS() && bannerAllowed()) {
        setText('pwa-install-title', 'Установить на iPhone?');
        setText('pwa-install-text',
            'Откройте сайт в Safari → кнопка «Поделиться» → «На экран „Домой“». ' +
            'Значок FreeDOM появится на рабочем столе, приложение откроется без адресной строки.');
        hide('pwa-install-btn');
        installBannerReady = true;
        showBanners();
    }
}

/** Карточка установки уместна: не внутри приложения, не «✕» и не «Позже». */
function bannerAllowed() {
    return !isStandalone()
        && localStorage.getItem(OFFER_KEY) !== 'no'
        && sessionStorage.getItem(SNOOZE_KEY) !== 'yes';
}

// =====================================================================
// РАЗДЕЛ «ПРИЛОЖЕНИЕ» В НАСТРОЙКАХ
// =====================================================================

/**
 * Рисует раздел «Приложение» в окне настроек: состояние приложения, кнопку
 * установки (её даёт не каждый браузер) и шаги для своего устройства.
 * Вызывается из js/settings.js → renderSettings() при каждом открытии окна,
 * поэтому окно всегда показывает текущее состояние.
 */
export function renderAppSection() {
    const statusEl = document.getElementById('settings-app-status');
    if (!statusEl) return;   // разметки нет — например, в браузере остался старый index.html

    const installed = isInstalled();

    if (installed) {
        statusEl.className = 'bg-emerald-50 border border-emerald-200 rounded-lg p-3 text-xs text-emerald-900';
        statusEl.textContent = t('settings.appInstalled');
    } else {
        statusEl.className = 'bg-gray-50 border rounded-lg p-3 text-xs text-gray-600';
        statusEl.textContent = t('settings.appBrowser');
    }

    // Кнопка установки — только там, где браузер её дал, и пока приложение не
    // установлено: предлагать установку установленному приложению нечего.
    toggle('settings-app-install', !installed && !!installPrompt);

    // Шаги: когда кнопки нет, они раскрыты — иначе сотрудник видит «установить
    // нельзя» и не знает, что делать.
    toggle('settings-app-hint', !installed && !installPrompt);

    const steps = document.getElementById('settings-app-steps');
    if (steps) {
        steps.classList.toggle('hidden', installed);
        steps.open = !installed && !installPrompt;
        renderDeviceSteps();
    }

    renderUpdateStatus();
    askBrowserAboutInstall();   // уточняем состояние у браузера (асинхронно)
}

/** Приложение установлено на этом устройстве? (признаки — в шапке файла) */
function isInstalled() {
    return isStandalone()
        || installedKnown === true
        || localStorage.getItem(INSTALLED_KEY) === 'yes';
}

/** Подпись под кнопкой обновления: «есть новая версия» или «последняя версия». */
async function renderUpdateStatus() {
    const el = document.getElementById('settings-app-update-status');
    if (!el) return;

    if (updateBannerReady) {
        el.className = 'text-[11px] text-amber-700';
        el.textContent = t('settings.updateReady');
        return;
    }

    const revision = await readShellRevision();
    el.className = 'text-[11px] text-gray-500';
    el.textContent = t('settings.updateCurrent', {
        version: revision ? `${CONFIG.APP.VERSION} · ${revision}` : CONFIG.APP.VERSION
    });
}

/** Шаги установки для текущего устройства (сами тексты — в разметке). */
function renderDeviceSteps() {
    toggle('install-steps-desktop', !isIOS() && !isAndroid());
    toggle('install-steps-android', isAndroid());
    toggle('install-steps-ios', isIOS());
}

/**
 * Спрашивает браузер, не установлено ли приложение на этом устройстве.
 * Chrome отвечает на этот вопрос (navigator.getInstalledRelatedApps — приложение
 * перечислено в related_applications своего манифеста), Safari и Firefox — нет:
 * там состояние определяют признаки из isInstalled().
 */
async function askBrowserAboutInstall() {
    if (installedKnown !== null) return installedKnown;
    if (typeof navigator.getInstalledRelatedApps !== 'function') {
        installedKnown = false;
        return false;
    }

    try {
        const related = await navigator.getInstalledRelatedApps();
        installedKnown = Array.isArray(related) && related.length > 0;
    } catch (error) {
        // Приватное окно или http:// — метод отвечает ошибкой. Это не поломка:
        // считаем, что приложение не установлено, и показываем шаги установки.
        installedKnown = false;
    }

    if (installedKnown) renderAppSection();   // статус изменился — перерисуем
    return installedKnown;
}

/** Ревизия оболочки из имени кэша: `freedom-v2.12.0-r9` → `r9`. */
async function readShellRevision() {
    try {
        if (typeof caches === 'undefined') return '';
        const keys = await caches.keys();
        const mine = keys.find((key) => key.startsWith(`${CACHE_PREFIX}-v${CONFIG.APP.VERSION}-`));
        return mine ? mine.slice(mine.lastIndexOf('-') + 1) : '';
    } catch (error) {
        return '';
    }
}

/** Перерисовывает раздел настроек, если окно открыто (рисует js/settings.js). */
function refreshAppSection() {
    if (typeof window.renderSettings !== 'function') return;
    const modal = document.getElementById('settings-modal');
    if (!modal || modal.classList.contains('hidden')) return;
    window.renderSettings();
}

// =====================================================================
// ОБНОВЛЕНИЕ ВЕРСИИ
// =====================================================================

// Сколько ждём ответа «скачал новую версию» — обновление обычно занимает
// доли секунды, но на слабой связи иначе как ждать и не проверить.
const UPDATE_TIMEOUT = 10000;

/**
 * Кнопка «🔄 Обновить приложение» в настройках. Скачанную версию включаем
 * сразу, иначе просим браузер проверить обновление и ждём до 10 секунд.
 * Если новой версии нет, об этом сообщаем: сотрудник не должен гадать,
 * нажалась кнопка или нет.
 */
window.pwaUpdateNow = async function pwaUpdateNow() {
    if (updateBusy) return;
    updateBusy = true;

    const button = document.getElementById('settings-app-update');
    const statusEl = document.getElementById('settings-app-update-status');
    if (button) button.disabled = true;
    if (statusEl) {
        statusEl.className = 'text-[11px] text-gray-500';
        statusEl.textContent = t('settings.updateChecking');
    }

    try {
        const registration = 'serviceWorker' in navigator
            ? await navigator.serviceWorker.getRegistration()
            : null;

        if (!registration) {
            // Service worker не зарегистрирован (http:// или очень старый браузер)
            toast(t('settings.updateFailed'), 'error');
            return;
        }

        if (registration.waiting) {
            applyUpdate(registration);   // версия уже скачана — включаем её
            return;
        }

        await registration.update();     // «есть ли новая версия?»
        if (await waitForInstall(registration)) {
            applyUpdate(registration);
            return;
        }

        toast(t('settings.updateCurrent', { version: CONFIG.APP.VERSION }), 'success');
    } catch (error) {
        log.warn('PWA: не удалось проверить обновление', error);
        toast(t('settings.updateFailed'), 'error');
    } finally {
        updateBusy = false;
        if (button) button.disabled = false;
        renderUpdateStatus();
    }
};

/**
 * Ждёт, пока браузер скачает новую версию.
 * @returns {Promise<boolean>} true — новая версия скачана и ждёт активации
 */
function waitForInstall(registration) {
    if (registration.waiting) return Promise.resolve(true);
    if (registration.installing) return waitInstalled(registration.installing);

    return new Promise((resolve) => {
        let done = false;
        const finish = (result) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            registration.removeEventListener('updatefound', onFound);
            resolve(result);
        };
        const onFound = () => {
            if (registration.installing) waitInstalled(registration.installing).then(finish);
        };
        const timer = setTimeout(() => finish(false), UPDATE_TIMEOUT);
        registration.addEventListener('updatefound', onFound);
    });
}

/** Ждёт, пока скачанный worker перейдёт в состояние 'installed'. */
function waitInstalled(worker) {
    if (worker.state === 'installed') return Promise.resolve(true);

    return new Promise((resolve) => {
        const timer = setTimeout(() => resolve(false), UPDATE_TIMEOUT);
        worker.addEventListener('statechange', () => {
            if (worker.state !== 'installed') return;
            clearTimeout(timer);
            resolve(true);
        });
    });
}

/** Включает скачанную версию: worker активируется, страница перезагружается. */
function applyUpdate(registration) {
    updateRequested = true;
    if (registration && registration.waiting) {
        registration.waiting.postMessage({ type: 'SKIP_WAITING' });
        return;   // controllerchange → window.location.reload()
    }
    window.location.reload();
}

// =====================================================================
// УДАЛЕНИЕ ПРИЛОЖЕНИЯ
// =====================================================================

/** Кнопка «🗑 Удалить приложение с устройства»: шаги для ярлыка и подтверждение. */
window.pwaUninstall = function pwaUninstall() {
    const ask = document.getElementById('pwa-uninstall-ask');
    const done = document.getElementById('pwa-uninstall-done');
    if (ask) ask.classList.remove('hidden');
    if (done) done.classList.add('hidden');

    renderUninstallSteps();
    showModal('pwa-uninstall-modal');
};

/** Шаги удаления ярлыка зависят от устройства (тексты — в разметке). */
function renderUninstallSteps() {
    toggle('pwa-uninstall-desktop', !isIOS() && !isAndroid());
    toggle('pwa-uninstall-android', isAndroid());
    toggle('pwa-uninstall-ios', isIOS());
}

/**
 * Подтверждение удаления: снимаем с устройства кэш оболочки и service worker,
 * убираем признак «приложение установлено». Ярлык и запись в системе удаляет
 * само устройство — шаги остаются на экране, чтобы их было откуда повторить.
 */
window.pwaUninstallConfirm = async function pwaUninstallConfirm() {
    await clearAppStorage();

    installedKnown = false;
    installBannerReady = false;
    updateBannerReady = false;
    localStorage.removeItem(INSTALLED_KEY);
    hide('pwa-install-banner');
    hide('pwa-update-banner');

    const ask = document.getElementById('pwa-uninstall-ask');
    const done = document.getElementById('pwa-uninstall-done');
    if (ask) ask.classList.add('hidden');
    if (done) done.classList.remove('hidden');

    log.info('PWA: файлы приложения и кэш удалены с устройства');
    refreshAppSection();
};

/** Снимает с устройства кэш оболочки и service worker приложения. */
async function clearAppStorage() {
    if (typeof caches !== 'undefined') {
        try {
            const keys = await caches.keys();
            await Promise.all(keys
                .filter((key) => key.startsWith(CACHE_PREFIX) || key.startsWith(LEGACY_CACHE_PREFIX))
                .map((key) => caches.delete(key)));
        } catch (error) {
            log.warn('PWA: не удалось удалить кэш приложения', error);
        }
    }

    if (!('serviceWorker' in navigator)) return;

    try {
        const registrations = await navigator.serviceWorker.getRegistrations();
        await Promise.all(registrations.map((registration) => registration.unregister()));
    } catch (error) {
        log.warn('PWA: не удалось отключить service worker', error);
    }
}

// =====================================================================
// КНОПКИ КАРТОЧЕК И НАСТРОЕК
// =====================================================================

/**
 * Установить приложение: отдаём браузеру сохранённое событие
 * beforeinstallprompt. Если события нет (iPhone, Firefox), кнопки и нет —
 * остаются шаги установки.
 */
window.pwaInstall = async function pwaInstall() {
    if (!installPrompt) return;

    const { outcome } = await installPrompt.prompt();   // 'accepted' | 'dismissed'
    log.info(`PWA: установка приложения — ${outcome}`);

    installPrompt = null;
    installBannerReady = false;
    hide('pwa-install-banner');

    if (outcome === 'dismissed') {
        sessionStorage.setItem(SNOOZE_KEY, 'yes');      // не пристаём до конца сеанса
    }
    refreshAppSection();
};

/**
 * Закрыть карточку установки.
 * @param {boolean} forever — true: «✕» (не предлагать никогда), false: «Позже»
 */
window.pwaDismissInstall = function pwaDismissInstall(forever) {
    hide('pwa-install-banner');
    if (forever === true) {
        localStorage.setItem(OFFER_KEY, 'no');
    } else {
        sessionStorage.setItem(SNOOZE_KEY, 'yes');
    }
};

/** «Обновить» в карточке новой версии: включаем скачанную версию. */
window.pwaApplyUpdate = async function pwaApplyUpdate() {
    const registration = 'serviceWorker' in navigator
        ? await navigator.serviceWorker.getRegistration()
        : null;
    applyUpdate(registration);
};

/** Отложить обновление до следующего запуска. */
window.pwaHideUpdate = function pwaHideUpdate() {
    hide('pwa-update-banner');
};

// =====================================================================
// ПОКАЗ КАРТОЧЕК
// =====================================================================

/**
 * Карточки живут поверх приложения (position: fixed), поэтому показываем их
 * только когда #app-container виден — то есть после входа сотрудника.
 */
function watchAppContainer() {
    const container = document.getElementById('app-container');
    if (!container) return;

    const check = () => {
        if (container.classList.contains('hidden')) {
            hide('pwa-install-banner');
            hide('pwa-update-banner');
            return;
        }
        showBanners();
    };

    new MutationObserver(check).observe(container, { attributes: true, attributeFilter: ['class'] });
    check();
}

function showBanners() {
    const container = document.getElementById('app-container');
    if (!container || container.classList.contains('hidden')) return;   // ждём входа

    if (installBannerReady) show('pwa-install-banner');
    if (updateBannerReady) show('pwa-update-banner');
}

// =====================================================================
// ОПРЕДЕЛЕНИЕ ПЛАТФОРМЫ И МЕЛОЧИ
// =====================================================================

/** Приложение уже открыто как установленное (без адресной строки браузера)? */
function isStandalone() {
    return window.matchMedia('(display-mode: standalone)').matches
        || window.matchMedia('(display-mode: minimal-ui)').matches
        || window.matchMedia('(display-mode: window-controls-overlay)').matches
        || window.navigator.standalone === true;
}

/** iPhone / iPad: установка только вручную через меню «Поделиться» в Safari. */
function isIOS() {
    return /iPad|iPhone|iPod/.test(navigator.userAgent)
        || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);   // iPad с iPadOS 13+
}

/** Android: шаги установки — пункт меню браузера «Установить приложение». */
function isAndroid() {
    return /Android/i.test(navigator.userAgent);
}

function show(id) {
    const el = document.getElementById(id);
    if (el) el.classList.remove('hidden');
}

function hide(id) {
    const el = document.getElementById(id);
    if (el) el.classList.add('hidden');
}

/** Показывает/прячет блок по id. */
function toggle(id, visible) {
    const el = document.getElementById(id);
    if (el) el.classList.toggle('hidden', !visible);
}

function setText(id, text) {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
}
