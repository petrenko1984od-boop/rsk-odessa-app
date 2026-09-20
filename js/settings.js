// =====================================================================
// МОДУЛЬ: НАСТРОЙКИ ПРИЛОЖЕНИЯ
// =====================================================================
// Окно «⚙ Настройки» (открывается из меню «Кабинет»):
//   * язык интерфейса — 🇷🇺 русский (по умолчанию) или 🇺🇦 українська;
//   * цветовая схема — 6 вариантов, по умолчанию зелёная.
// Обе настройки хранятся в localStorage устройства: каждый сотрудник
// выбирает своё оформление, на других это не влияет.
// =====================================================================

import { toast, showModal } from './utils.js';
import { CONFIG } from './config.js';
import {
    LANGUAGES, getLang, setLang, t
} from './i18n.js';
import { THEMES, getTheme, setTheme } from './theme.js';

// =====================================================================
// ОТРИСОВКА
// =====================================================================

function renderLanguages() {
    const box = document.getElementById('settings-languages');
    if (!box) return;

    const active = getLang();

    box.innerHTML = LANGUAGES.map(lang => {
        const isActive = lang.code === active;
        const cls = isActive
            ? 'bg-[#15803d] text-white border-[#15803d]'
            : 'bg-white text-gray-700 border-gray-200 hover:border-[#15803d]';

        return `
            <button type="button" onclick="window.chooseLanguage('${lang.code}')"
                    class="flex-1 border-2 rounded-lg px-3 py-2.5 text-sm font-semibold transition ${cls}">
                ${lang.label}
            </button>
        `;
    }).join('');
}

function renderThemes() {
    const box = document.getElementById('settings-themes');
    if (!box) return;

    const active = getTheme();

    box.innerHTML = THEMES.map(theme => {
        const isActive = theme.id === active;
        const label = getLang() === 'uk' ? theme.labelUk : theme.label;

        return `
            <button type="button" onclick="window.chooseTheme('${theme.id}')"
                    title="${label}"
                    class="flex flex-col items-center gap-1 ${isActive ? 'font-bold' : ''}">
                <span class="w-9 h-9 rounded-full border-2 ${isActive ? 'border-gray-800' : 'border-white'}"
                      style="background:${theme.swatch}"></span>
                <span class="text-[10px] ${isActive ? 'text-gray-900' : 'text-gray-500'}">${label}</span>
            </button>
        `;
    }).join('');
}

/** Показывает версию и текущие настройки (перерисовывается при каждом открытии). */
export function renderSettings() {
    renderLanguages();
    renderThemes();

    const versionEl = document.getElementById('settings-version');
    if (versionEl) versionEl.textContent = `${CONFIG.APP.NAME} v${CONFIG.APP.VERSION}`;
}

/** Открывает окно настроек. */
export function openSettings() {
    const menu = document.getElementById('profile-menu');
    if (menu) menu.classList.add('hidden');

    renderSettings();
    showModal('settings-modal');
}

// =====================================================================
// ДЕЙСТВИЯ
// =====================================================================

/** Выбор языка интерфейса (кнопка в окне настроек). */
export function chooseLanguage(code) {
    setLang(code);
    renderSettings();
    toast(t('settings.saved'), 'success');
}

/** Выбор цветовой схемы (кружок в окне настроек). */
export function chooseTheme(id) {
    setTheme(id);
    renderSettings();
    toast(t('settings.saved'), 'success');
}

// =====================================================================
// ГЛОБАЛЬНЫЕ ФУНКЦИИ
// =====================================================================

window.openSettings = openSettings;
window.chooseLanguage = chooseLanguage;
window.chooseTheme = chooseTheme;
window.renderSettings = renderSettings;
