// =====================================================================
// FREEDOM — ЦВЕТОВЫЕ СХЕМЫ
// =====================================================================
// Приложение по умолчанию зелёное. В «Настройках» сотрудник выбирает свой
// цвет: выбор хранится в localStorage устройства и ни на кого не влияет.
//
// Как это работает: css/theme.css перекрашивает «фирменные» классы Tailwind
// (bg-[#15803d], text-emerald-700 и т.п.) через CSS-переменные, а тема — это
// набор значений этих переменных для html[data-theme="..."]. Поэтому новая
// тема = несколько строк в theme.css, код модулей трогать не нужно.
//
// Модуль ничего не импортирует (его подключают и utils.js, и main.js).
// =====================================================================

// «Красная» — фирменный красный логотипа (#c8102e); остальные схемы как раньше.
// Сами оттенки каждой схемы лежат в css/theme.css (блоки html[data-theme="…"]).
export const THEMES = [
    { id: 'green',    label: 'Зелёная',   labelUk: 'Зелена',     swatch: '#15803d' },
    { id: 'blue',     label: 'Синяя',     labelUk: 'Синя',       swatch: '#1d4ed8' },
    { id: 'red',      label: 'Красная',   labelUk: 'Червона',    swatch: '#c8102e' },
    { id: 'teal',     label: 'Бирюзовая', labelUk: 'Бірюзова',   swatch: '#0f766e' },
    { id: 'amber',    label: 'Янтарная',  labelUk: 'Бурштинова', swatch: '#b45309' },
    { id: 'graphite', label: 'Графит',    labelUk: 'Графіт',     swatch: '#374151' }
];

// По умолчанию — «Красная»: это фирменный цвет логотипа FreeDOM, поэтому
// приложение при первом входе выглядит «как в документации». Выбор сотрудника
// (в т.ч. зелёный) лежит в localStorage и приоритетнее: у кого цвет выбран
// руками, оформление не меняется.
export const DEFAULT_THEME = 'red';

// Схема «Индиго» заменена на «Красную». У сотрудников, которые её выбрали, в
// localStorage устройства осталось прежнее имя: переводим его на новую схему,
// чтобы оформление не «сбрасывалось» на схему по умолчанию.
const LEGACY_THEME_IDS = { indigo: 'red' };

const STORAGE_KEY = 'rsk.theme';

let currentTheme = DEFAULT_THEME;
let observers = [];

export function getThemes() {
    return THEMES;
}

export function getTheme() {
    return currentTheme;
}

export function isDefaultTheme() {
    return currentTheme === DEFAULT_THEME;
}

/**
 * Применяет тему к документу: атрибут data-theme на <html> включает нужный
 * набор переменных, а цвет строки браузера (theme-color) подкрашивается под
 * выбранный цвет — иначе на телефоне останется зелёная полоса.
 */
export function applyTheme(id) {
    const wanted = LEGACY_THEME_IDS[id] || id;
    const theme = THEMES.find(item => item.id === wanted) || THEMES[0];
    currentTheme = theme.id;

    const root = document.documentElement;
    root.setAttribute('data-theme', theme.id);

    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', theme.swatch);

    return theme;
}

/** Смена темы с сохранением выбора этого устройства. */
export function setTheme(id) {
    const theme = applyTheme(id);

    try {
        localStorage.setItem(STORAGE_KEY, theme.id);
    } catch {
        // Приватный режим — просто не запоминаем выбор
    }

    observers.forEach(fn => {
        try { fn(theme.id); } catch (err) { console.warn('[theme] подписчик упал:', err); }
    });

    return theme.id;
}

export function onThemeChange(fn) {
    if (typeof fn === 'function') observers.push(fn);
}

/** Вызывается один раз при старте приложения (js/main.js). */
export function initTheme() {
    let saved = null;

    try {
        saved = localStorage.getItem(STORAGE_KEY);
    } catch {
        // Хранилище недоступно — тема по умолчанию
    }

    // applyTheme сам снимает устаревшие имена (LEGACY_THEME_IDS) и подставляет
    // тему по умолчанию, если сохранённого имени нет в списке.
    applyTheme(saved);

    return currentTheme;
}

// Отладка через консоль: theme.setTheme('blue')
if (typeof window !== 'undefined') {
    window.theme = { setTheme, getTheme, applyTheme, initTheme, THEMES };
}
