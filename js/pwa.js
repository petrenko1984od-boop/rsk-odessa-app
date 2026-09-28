// =====================================================================
// FREEDOM — PWA: УСТАНОВКА ПРИЛОЖЕНИЯ И ОБНОВЛЕНИЕ ВЕРСИИ
// =====================================================================
// Что здесь происходит:
//   1) регистрируем service worker (sw.js) — без него браузер не предложит
//      «Установить приложение», и приложение не откроется без сети;
//   2) показываем карточку «Установить FreeDOM» (#pwa-install-banner),
//      когда браузер разрешил установку (событие beforeinstallprompt).
//      На iPhone такого события нет — там показываем подсказку
//      «Поделиться → На экран „Домой“»: установить приложение за
//      пользователя Safari не позволяет;
//   3) когда service worker скачал новую версию, предлагаем «Обновить»
//      (#pwa-update-banner): иначе сотрудник останется на старых файлах;
//   4) постоянный пункт меню «Кабинет» → «📲 Установить приложение» открывает
//      окно (#install-modal) с шагами для своего устройства. Карточка внизу
//      показывается один раз и только там, где браузер разрешил установку, а
//      после «✕» — никогда; окно же доступно всегда, поэтому сотрудник может
//      установить приложение и позже, и на другом устройстве.
//
// Разметка обеих карточек — в index.html. Показываем их только внутри
// приложения (после входа): на экране авторизации они закрывали бы форму,
// поэтому следим за class у #app-container.
// =====================================================================

import { CONFIG } from './config.js';
import { log, hideModal, showModal } from './utils.js';

const OFFER_KEY = 'rsk.pwa.install';   // 'no' — от установки отказались навсегда
const SNOOZE_KEY = 'rsk.pwa.snooze';   // 'yes' — «Позже» до конца сеанса

let installPrompt = null;       // сохранённое событие beforeinstallprompt
let installBannerReady = false; // есть что показать про установку
let updateBannerReady = false;  // есть скачанная новая версия
let updateRequested = false;    // пользователь нажал «Обновить» → перезагружаемся

// =====================================================================
// ТОЧКА ВХОДА (вызывается из boot() в js/main.js)
// =====================================================================

export function initPWA() {
    registerServiceWorker();
    setupInstallOffer();
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
            }
        });
    });
}

// =====================================================================
// УСТАНОВКА ПРИЛОЖЕНИЯ
// =====================================================================

function setupInstallOffer() {
    if (isStandalone()) return;                                // уже открыто как приложение
    if (localStorage.getItem(OFFER_KEY) === 'no') return;      // от предложения отказались
    if (sessionStorage.getItem(SNOOZE_KEY) === 'yes') return;  // «Позже» в этом сеансе

    if (isIOS()) {
        // Safari не умеет устанавливать приложение по кнопке — только через меню «Поделиться»
        setText('pwa-install-title', 'Установить на iPhone?');
        setText('pwa-install-text',
            'Откройте сайт в Safari → кнопка «Поделиться» → «На экран „Домой“». ' +
            'Значок FreeDOM появится на рабочем столе, приложение откроется без адресной строки.');
        hide('pwa-install-btn');
        installBannerReady = true;
        return;
    }

    window.addEventListener('beforeinstallprompt', (event) => {
        event.preventDefault();       // не показываем системную плашку — покажем свою
        installPrompt = event;
        installBannerReady = true;
        showBanners();
        showInstallButton();          // окно установки могло быть открыто раньше события
    });

    window.addEventListener('appinstalled', () => {
        log.info('PWA: приложение установлено');
        installPrompt = null;
        installBannerReady = false;
        localStorage.setItem(OFFER_KEY, 'no');   // больше не предлагаем
        hide('pwa-install-banner');
        hideModal('install-modal');
    });
}

// =====================================================================
// ОКНО «📲 УСТАНОВИТЬ ПРИЛОЖЕНИЕ» (постоянный пункт меню «Кабинет»)
// =====================================================================
// Зачем окно, если есть карточка: карточку браузер разрешает показать не
// всегда (событие beforeinstallprompt приходит только на «устанавливаемых»
// устройствах), а после «✕» она не появляется никогда — сотрудник остаётся
// без подсказки, хотя установить приложение можно через меню браузера. Здесь
// порядок шагов для его устройства и кнопка установки, когда браузер её даёт.

/** Показывает/прячет блок окна по id. */
function toggle(id, visible) {
    const el = document.getElementById(id);
    if (el) el.classList.toggle('hidden', !visible);
}

/** Кнопка установки: браузер разрешает её не всегда — тогда остаются шаги. */
function showInstallButton() {
    toggle('install-modal-btn', !!installPrompt);
    toggle('install-hint', !installPrompt);
}

/** Заполняет окно установки по текущему устройству (тексты шагов — в разметке). */
function renderInstallHelp() {
    toggle('install-steps-desktop', false);
    toggle('install-steps-android', false);
    toggle('install-steps-ios', false);
    toggle('install-done', false);

    if (isStandalone()) {
        // Приложение уже открыто отдельным окном — ставить нечего, и говорить
        // про меню браузера незачем.
        toggle('install-done', true);
        toggle('install-modal-btn', false);
        toggle('install-hint', false);
        return;
    }

    showInstallButton();

    if (isIOS()) toggle('install-steps-ios', true);
    else if (isAndroid()) toggle('install-steps-android', true);
    else toggle('install-steps-desktop', true);
}

/** Открывает окно установки (пункт меню «Кабинет» → «📲 Установить приложение»). */
window.openInstallHelp = function openInstallHelp() {
    const menu = document.getElementById('profile-menu');
    if (menu) menu.classList.add('hidden');

    renderInstallHelp();
    showModal('install-modal');
};

// =====================================================================
// КНОПКИ КАРТОЧЕК (вызываются из onclick в index.html)
// =====================================================================

/**
 * Установить приложение: отдаём браузеру сохранённое событие beforeinstallprompt.
 * Если события нет (iPhone, Firefox) — подсказка уже показана текстом карточки.
 */
window.pwaInstall = async function pwaInstall() {
    if (!installPrompt) return;

    const { outcome } = await installPrompt.prompt();   // 'accepted' | 'dismissed'
    log.info(`PWA: установка приложения — ${outcome}`);

    installPrompt = null;
    installBannerReady = false;
    hide('pwa-install-banner');
    hideModal('install-modal');       // окно «Установить приложение», если оно открыто

    if (outcome === 'dismissed') {
        sessionStorage.setItem(SNOOZE_KEY, 'yes');      // не пристаём до конца сеанса
    }
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

/** Обновить приложение: активируем скачанный service worker и перезагружаем страницу. */
window.pwaApplyUpdate = async function pwaApplyUpdate() {
    updateRequested = true;

    const registration = await navigator.serviceWorker.getRegistration();
    if (registration && registration.waiting) {
        registration.waiting.postMessage({ type: 'SKIP_WAITING' });
        return;   // controllerchange → window.location.reload()
    }
    window.location.reload();
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

function setText(id, text) {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
}
