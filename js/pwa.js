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
//      (#pwa-update-banner): иначе сотрудник останется на старых файлах.
//
// Разметка обеих карточек — в index.html. Показываем их только внутри
// приложения (после входа): на экране авторизации они закрывали бы форму,
// поэтому следим за class у #app-container.
// =====================================================================

import { CONFIG } from './config.js';
import { log } from './utils.js';

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
    });

    window.addEventListener('appinstalled', () => {
        log.info('PWA: приложение установлено');
        installPrompt = null;
        installBannerReady = false;
        localStorage.setItem(OFFER_KEY, 'no');   // больше не предлагаем
        hide('pwa-install-banner');
    });
}

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
