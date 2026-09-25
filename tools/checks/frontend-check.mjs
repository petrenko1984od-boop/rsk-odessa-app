// =====================================================================
// Прогон БЕЗ БРАУЗЕРА (только Node): фронтенд для прода
// =====================================================================
// Зачем: до v2.9.0-r2 приложение зависело от того, ЧЕГО НЕ ВИДНО В КОДЕ.
//
//   * Tailwind подключался как Play CDN (`cdn.tailwindcss.com`) — браузер
//     сотрудника скачивал чужой скрипт, без сети стилей не было вовсе, SRI
//     поставить нельзя, а CSP приходилось бы разрешать внешнему домену.
//     Теперь стили собираются заранее (`npm run build`) и лежат в
//     css/tailwind.css. Но здесь появляется новая ловушка: класс, добавленный
//     в разметку или в шаблон модуля и НЕ попавший в сборку, молча ничего не
//     красит — раньше это чинил Play CDN, он генерировал классы на лету.
//     Поэтому прогон сверяет отпечаток сборки с текущими исходниками и
//     проверяет, что классы разметки есть в готовом CSS;
//   * нажатия шли встроенными обработчиками (`onclick="..."`), из-за чего
//     включить Content-Security-Policy без `'unsafe-inline'` было нельзя
//     (а это главная защита от внедрённого скрипта). Теперь разметка называет
//     действие (`data-action`, см. js/actions.js). Ловушка перехода: опечатка
//     в имени действия не видна — кнопка просто не нажимается. Прогон сверяет
//     каждое имя с тем, что модули выставляют на `window`;
//   * политика CSP записана ДВАЖДЫ (meta в index.html для локального запуска и
//     заголовок в vercel.json для хостинга) — их надо править вместе, иначе
//     браузер применяет обе и что-то одно ломается. Прогон сравнивает политики
//     директива за директивой и проверяет, что каждый внешний хост, который
//     грузит разметка, в политике разрешён.
//
// Что проверяется (8 групп):
//   1. Tailwind собран локально (нет Play CDN, ссылка на css/tailwind.css на
//      месте и в правильном порядке, оба новых файла — в офлайн-оболочке sw.js);
//   2. отпечаток сборки совпадает с текущими исходниками (и с версией
//      приложения из js/config.js и sw.js);
//   3. точная пересборка даёт тот же файл (запускается, если установлен
//      пакет tailwindcss — в CI он есть);
//   4. классы разметки и модулей есть в готовом CSS (включая классы, которые
//      собираются не из строки, а из поля — «badge» групп задач);
//   5. в разметке и модулях не осталось встроенных обработчиков;
//   6. каждое `data-action` / `data-after` имеет реализацию;
//   7. CSP: политик две и они совпадают, `script-src` без 'unsafe-inline',
//      внешние хосты разметки разрешены, адрес базы (js/config.js) тоже;
//   8. инструменты на месте: линтер, скрипты сборки, замок зависимостей,
//      сборка прогонов в CI, а разметку и стили не выкинуло .vercelignore.
//
// Запуск:  node tools/checks/frontend-check.mjs   (из папки tools/checks)
// Код возврата 1, если есть замечания.
// =====================================================================


import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { listSources, sourceFingerprint, appVersion, STAMP_PREFIX } from '../tailwind-sources.mjs';

const ROOT = process.env.APP_ROOT
    ? path.resolve(process.env.APP_ROOT)
    : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const INDEX = path.join(ROOT, 'index.html');
const SW = path.join(ROOT, 'sw.js');
const CSS_OUT = path.join(ROOT, 'css', 'tailwind.css');
const CSS_IN = path.join(ROOT, 'src', 'tailwind.css');
const CONFIG_JS = path.join(ROOT, 'js', 'config.js');
const ACTIONS_JS = path.join(ROOT, 'js', 'actions.js');
const MAIN_JS = path.join(ROOT, 'js', 'main.js');
const VERCEL = path.join(ROOT, 'vercel.json');
const VERCEL_IGNORE = path.join(ROOT, '.vercelignore');
const LOCK = path.join(ROOT, 'package-lock.json');
const ESLINT = path.join(ROOT, 'eslint.config.mjs');
const PKG = path.join(ROOT, 'package.json');
const WORKFLOW = path.join(ROOT, '.github', 'workflows', 'ci.yml');
const TW_CLI = path.join(ROOT, 'node_modules', 'tailwindcss', 'lib', 'cli.js');

const report = [];
const log = (...args) => { const line = args.join(' '); report.push(line); console.log(line); };

let failed = 0;
const ok = (name, cond, extra = '') => {
    log((cond ? '  ok   ' : '  FAIL ') + name + (extra ? ' :: ' + extra : ''));
    if (!cond) failed += 1;
};

const read = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '');
const rel = (file) => path.relative(ROOT, file).replace(/\\/g, '/');

/** Номер строки в файле — чтобы замечание можно было найти руками. */
const lineOf = (text, index) => text.slice(0, index).split('\n').length;

/**
 * Классы, собранные не из строки, а из поля: в разметку попадает поле
 * (`group.badge`), а имя класса лежит строкой в модуле — сборщик Tailwind
 * такую строку видит, а глаз может и не заметить. Список фиксированный:
 * именно эти классы Play CDN раньше «дорисовывал» на лету.
 */
const DYNAMIC_CLASSES = [
    'bg-yellow-100', 'text-yellow-800',
    'bg-blue-100', 'text-blue-800',
    'bg-green-100', 'text-green-800'
];

/** События, обработчики которых нельзя писать в разметку (CSP). */
const INLINE_EVENTS = [
    'click', 'change', 'input', 'submit', 'keydown', 'keyup', 'keypress',
    'error', 'load', 'blur', 'focus', 'mouseenter', 'mouseleave', 'dblclick',
    'contextmenu', 'touchstart', 'dragover', 'drop', 'paste', 'invalid'
];
const INLINE_HANDLER = new RegExp('\\son(?:' + INLINE_EVENTS.join('|') + ')\\s*=\\s*["\']', 'g');

/** Все файлы интерфейса: разметка плюс модули (без инструментов и проверок). */
function uiFiles() {
    const files = [INDEX];
    const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (entry.name.endsWith('.js')) files.push(full);
        }
    };
    walk(path.join(ROOT, 'js'));
    return files;
}



/**
 * Имена классов из текста: атрибуты `class="..."` (разметка и шаблоны
 * модулей), `classList.add/remove/toggle('...')` и `className = '...'`.
 * Токены с подстановкой (`class="... ${group.badge}"`) пропускаем: имя
 * собирается в рантайме, и проверяемая строка здесь ни при чём.
 */
function classTokens(text) {
    const tokens = new Set();
    const sources = [];

    for (const match of text.matchAll(/class\s*=\s*"([^"]*)"/g)) sources.push(match[1]);
    for (const match of text.matchAll(/className\s*=\s*'([^']*)'/g)) sources.push(match[1]);
    for (const match of text.matchAll(/classList\.(?:add|remove|toggle)\(\s*'([^']*)'/g)) sources.push(match[1]);

    for (const source of sources) {
        if (source.includes('${')) continue;
        for (const token of source.split(/\s+/)) {
            if (token && !token.includes('$') && !token.includes('{') && !token.includes('&')) {
                tokens.add(token);
            }
        }
    }
    return tokens;
}

/**
 * Есть ли класс в собранном CSS. Tailwind экранирует в селекторе всё, кроме
 * букв, цифр, `-` и `_` (`bg-[#15803d]` → `.bg-\[\#15803d\]`), поэтому ищем
 * оба варианта — как есть и экранированный.
 */
function cssHasClass(css, token) {
    if (css.includes('.' + token)) return true;
    const escaped = token.replace(/[^a-zA-Z0-9_-]/g, (char) => '\\' + char);
    return css.includes('.' + escaped);
}

/** Политика CSP → карта «директива → отсортированный список источников». */
function cspDirectives(policy) {
    const map = new Map();
    for (const part of String(policy).split(';')) {
        const words = part.trim().split(/\s+/).filter(Boolean);
        if (!words.length) continue;
        const [name, ...sources] = words;
        map.set(name, sources.sort().join(' '));
    }
    return map;
}

/**
 * Классы-маркеры: правил для них нет ни в утилитах Tailwind, ни в своих
 * стилях — модули находят по ним поля формы (`row.querySelector('.cashreq-item-qty')`).
 * В сборке им делать нечего, поэтому класс считается «определённым» и тогда,
 * когда по нему ищут элементы в коде.
 */
function selectorTokens(text) {
    const tokens = new Set();
    for (const match of text.matchAll(/querySelector(?:All)?\(\s*['"`]\.([A-Za-z0-9_-]+)/g)) tokens.add(match[1]);
    for (const match of text.matchAll(/closest\(\s*['"`]\.([A-Za-z0-9_-]+)/g)) tokens.add(match[1]);
    for (const match of text.matchAll(/getElementsByClassName\(\s*['"`]([A-Za-z0-9_-]+)/g)) tokens.add(match[1]);
    return tokens;
}

/** Разрешён ли адрес директивами политики (учёт `'self'`, `*` и `*.домен`). */
function hostAllowed(sources, url) {
    const list = String(sources || '').split(/\s+/).filter(Boolean);

    if (list.includes('*')) return true;

    let target;
    try {
        target = new URL(String(url), 'https://local.test');
    } catch {
        return false;
    }

    return list.some((source) => {
        if (source === "'self'") return false;      // свои файлы проверяются отдельно
        if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(source)) return false;
        const allowed = new URL(source);
        if (allowed.protocol !== target.protocol) return false;
        if (allowed.hostname === target.hostname) return true;
        // Подстановочный поддомен: https://*.supabase.co
        if (allowed.hostname.startsWith('*.')) {
            return target.hostname.endsWith(allowed.hostname.slice(1));
        }
        return false;
    });
}

async function main() {
    const html = read(INDEX);
    const sw = read(SW);
    const css = read(CSS_OUT);
    const version = appVersion();

    // --- 1. Tailwind собран локально -------------------------------------
    log('=== 1. Tailwind собирается локально ===');
    ok('index.html больше не подключает cdn.tailwindcss.com',
        !/<script[^>]+src="https:\/\/cdn\.tailwindcss\.com/.test(html));
    ok('index.html подключает свой css/tailwind.css',
        /<link[^>]+href="\.\/css\/tailwind\.css"/.test(html));

    const posStyle = html.indexOf('./css/style.css');
    const posTailwind = html.indexOf('./css/tailwind.css');
    const posTheme = html.indexOf('./css/theme.css');
    ok('порядок в <head> сохранён: style.css → tailwind.css → theme.css',
        posStyle !== -1 && posTailwind !== -1 && posTheme !== -1 &&
        posStyle < posTailwind && posTailwind < posTheme,
        `style.css: ${posStyle}, tailwind.css: ${posTailwind}, theme.css: ${posTheme}`);

    const cssIn = read(CSS_IN);
    ok('исходник сборки src/tailwind.css на месте (в index.html его подключать нельзя — он без утилит)',
        /@tailwind\s+base/.test(cssIn) && /@tailwind\s+components/.test(cssIn) && /@tailwind\s+utilities/.test(cssIn));
    ok('css/tailwind.css — собранный файл, а не исходник',
        css.length > 5000 && !/@tailwind\s/.test(css), (css.length / 1024).toFixed(1) + ' КБ');
    ok('офлайн-оболочка знает про новые файлы (sw.js → APP_SHELL)',
        sw.includes("'./css/tailwind.css'") && sw.includes("'./js/actions.js'"));

    // --- 2. Отпечаток сборки ---------------------------------------------
    log('=== 2. Отпечаток сборки соответствует исходникам ===');
    const stamp = css.match(new RegExp('\\/\\* ' + STAMP_PREFIX + ' v([0-9.]+) ([0-9a-f]{16}) \\*\\/'));
    ok('в сборке есть строка-отпечаток (её ставит npm run build)', !!stamp,
        stamp ? stamp[0] : 'строки нет — файл собран вручную');

    if (stamp) {
        const swVersion = (sw.match(/const APP_VERSION = '([0-9.]+)'/) || [])[1];
        ok('версия сборки совпадает с версией приложения (js/config.js) и с sw.js',
            stamp[1] === version && swVersion === version,
            `сборка: ${stamp[1]}, js/config.js: ${version}, sw.js: ${swVersion}`);

        const current = sourceFingerprint();
        ok('сборка сделана из текущей разметки и модулей (иначе: npm run build)',
            stamp[2] === current, `в файле: ${stamp[2]}, сейчас: ${current}`);
    }
    ok('отпечаток считается по разметке и всем модулям',
        listSources().length >= 25, `файлов в отпечатке: ${listSources().length}`);

    // --- 3. Точная пересборка --------------------------------------------
    log('=== 3. Пересборка даёт тот же файл ===');
    if (!fs.existsSync(TW_CLI)) {
        log('  пропуск: нет node_modules/tailwindcss (npm install) — сравнение пропущено');
    } else {
        const { buildCss } = await import('../build-css.mjs');
        const tmpRel = 'css/tailwind.tmp.css';
        try {
            const done = buildCss({ output: tmpRel, quiet: true });
            const rebuilt = read(path.join(ROOT, tmpRel));
            const same = rebuilt.replace(/\r\n/g, '\n') === css.replace(/\r\n/g, '\n');
            ok('повторная сборка совпадает с закоммиченной байт в байт',
                same,
                same
                    ? `${(css.length / 1024).toFixed(1)} КБ, отпечаток ${done.fingerprint}`
                    : `пересборка: ${(rebuilt.length / 1024).toFixed(1)} КБ, в репозитории: ` +
                      `${(css.length / 1024).toFixed(1)} КБ — запустите npm run build и закоммитьте css/tailwind.css`);
        } finally {
            fs.rmSync(path.join(ROOT, tmpRel), { force: true });
        }
    }

    // --- 4. Классы разметки есть в готовом CSS ---------------------------
    log('=== 4. Классы разметки и модулей есть в сборке ===');
    const files = uiFiles();
    const tokens = new Set();
    for (const file of files) {
        for (const token of classTokens(read(file))) tokens.add(token);
    }
    // Часть классов — свои (`app-loading`, `cashreq-item-name` …): их правила
    // лежат в css/style.css и css/theme.css, а не в утилитах Tailwind. Поэтому
    // ищем класс и в сборке, и в собственных стилях: иначе прогон считал бы
    // ошибкой нормально работающую разметку.
    const ownCss = read(path.join(ROOT, 'css', 'style.css')) + '\n' + read(path.join(ROOT, 'css', 'theme.css'));
    const markerTokens = new Set();
    for (const file of files.filter((file) => file.endsWith('.js'))) {
        for (const token of selectorTokens(read(file))) markerTokens.add(token);
    }
    const inOwnCss = [...tokens].filter((token) => !cssHasClass(css, token) && cssHasClass(ownCss, token));
    const inJs = [...tokens].filter((token) =>
        !cssHasClass(css, token) && !cssHasClass(ownCss, token) && markerTokens.has(token));
    const missing = [...tokens].filter((token) =>
        !cssHasClass(css, token) && !cssHasClass(ownCss, token) && !markerTokens.has(token));
    ok(`все классы разметки и модулей есть в стилях (проверено: ${tokens.size}; своих: ${inOwnCss.length}; маркеров: ${inJs.length})`,
        missing.length === 0,
        missing.length
            ? 'нет ни в сборке, ни в css/style.css: ' + missing.slice(0, 6).join(', ') + ' — запустите npm run build'
            : '');

    const missingDynamic = DYNAMIC_CLASSES.filter((token) => !cssHasClass(css, token));
    ok('классы, собранные из поля (badge групп задач), тоже в сборке',
        missingDynamic.length === 0,
        missingDynamic.length ? 'нет: ' + missingDynamic.join(', ') : `проверено: ${DYNAMIC_CLASSES.length}`);

    // --- 5. Встроенных обработчиков нет ----------------------------------
    log('=== 5. Встроенных обработчиков (onclick="...") нет ===');
    const offenders = [];
    for (const file of files) {
        const text = read(file);
        INLINE_HANDLER.lastIndex = 0;
        let match;
        while ((match = INLINE_HANDLER.exec(text)) !== null) {
            offenders.push(`${rel(file)}:${lineOf(text, match.index)} (${match[0].trim()})`);
        }
    }
    ok('ни разметка, ни модули не вызывают функции из атрибутов (иначе CSP пришлось бы разрешить unsafe-inline)',
        offenders.length === 0,
        offenders.length ? offenders.slice(0, 5).join(' | ') : `запрещённых событий: ${INLINE_EVENTS.length}`);

    // --- 6. Действия data-action имеют реализацию ------------------------
    log('=== 6. Каждое data-action нажимается ===');
    const implemented = new Set();
    for (const file of files.filter((file) => file.endsWith('.js'))) {
        const text = read(file);
        for (const match of text.matchAll(/window\.([A-Za-z_$][\w$]*)\s*=/g)) implemented.add(match[1]);
        for (const match of text.matchAll(/window\['([A-Za-z_$][\w$]*)'\]\s*=/g)) implemented.add(match[1]);
    }
    // Встроенные действия диспетчера (BUILT_IN в js/actions.js): 'имя': () => ...
    for (const match of read(ACTIONS_JS).matchAll(/'([A-Za-z_$][\w$-]*)'\s*:/g)) implemented.add(match[1]);

    const usedActions = new Map();
    for (const file of files) {
        const text = read(file);
        for (const match of text.matchAll(/data-(?:action|after)="([^"]*)"/g)) {
            const name = match[1];
            if (!name || name.includes('$')) continue;   // имя собирается в рантайме (renderBlockFilters)
            if (!usedActions.has(name)) usedActions.set(name, `${rel(file)}:${lineOf(text, match.index)}`);
        }
    }
    const unknown = [...usedActions.keys()].filter((name) => !implemented.has(name));
    ok(`у каждого действия есть функция на window (проверено: ${usedActions.size})`,
        unknown.length === 0,
        unknown.length
            ? unknown.slice(0, 5).map((name) => `${name} (${usedActions.get(name)})`).join(' | ')
            : '');
    ok('диспетчер подключён к точке входа (import в js/main.js)',
        /import '\.\/actions\.js'/.test(read(MAIN_JS)));

    // Запасные надписи вместо логотипа: обработчик ошибки картинки живёт в
    // диспетчере, а цель (id) — в разметке. Ошибку в id иначе не заметить.
    const fallbackIds = [...html.matchAll(/data-fallback-show="([^"]+)"/g)].map((match) => match[1]);
    const missingFallback = fallbackIds.filter((id) => !new RegExp('id="' + id + '"').test(html));
    ok('у каждой картинки с data-fallback-show есть запасной блок по id',
        missingFallback.length === 0 && fallbackIds.length > 0,
        missingFallback.length
            ? 'нет элемента: ' + missingFallback.join(', ')
            : `картинок: ${fallbackIds.length}`);


    // --- 7. Content-Security-Policy --------------------------------------
    log('=== 7. Content-Security-Policy (в разметке и на хостинге) ===');
    const metaPolicies = [...html.matchAll(/<meta http-equiv="Content-Security-Policy" content="([^"]+)"/g)]
        .map((match) => match[1]);
    ok('в index.html ровно одна CSP', metaPolicies.length === 1, `найдено: ${metaPolicies.length}`);

    let headerPolicy = '';
    try {
        const vercel = JSON.parse(read(VERCEL));
        headerPolicy = (vercel.headers || [])
            .flatMap((entry) => entry.headers || [])
            .filter((header) => String(header.key).toLowerCase() === 'content-security-policy')
            .map((header) => String(header.value))[0] || '';
    } catch (error) {
        ok('vercel.json читается', false, String(error.message || error));
    }
    ok('политика продублирована заголовком на хостинге (vercel.json)', !!headerPolicy);

    if (metaPolicies.length === 1 && headerPolicy) {
        const meta = cspDirectives(metaPolicies[0]);
        const header = cspDirectives(headerPolicy);
        const names = [...new Set([...meta.keys(), ...header.keys()])];
        const different = names.filter((name) => meta.get(name) !== header.get(name));
        ok('meta и заголовок совпадают директива за директивой',
            different.length === 0,
            different.length
                ? 'расходятся: ' + different
                    .map((name) => `${name} (meta: ${meta.get(name)}, заголовок: ${header.get(name)})`)
                    .join(' | ')
                : `${names.length} директив`);

        ok("default-src закрывает всё незаданное (ожидается 'self')",
            meta.get('default-src') === "'self'", meta.get('default-src'));

        const scriptSrc = meta.get('script-src') || '';
        ok("script-src без 'unsafe-inline' и 'unsafe-eval'",
            !/unsafe-inline|unsafe-eval/.test(scriptSrc), scriptSrc);
        ok("'unsafe-inline' остался только в style-src (ширины полос прогресса задаются атрибутом style)",
            /'unsafe-inline'/.test(meta.get('style-src') || '') &&
            !names.some((name) => name !== 'style-src' && /'unsafe-inline'/.test(meta.get(name) || '')));

        // Внешние файлы разметки обязаны быть разрешены «своей» директивой.
        const external = [];
        for (const match of html.matchAll(/<script\b[^>]*>/gi)) {
            const src = (match[0].match(/src="([^"]+)"/) || [])[1];
            if (src && /^https?:/.test(src)) external.push({ kind: 'script-src', what: src });
        }
        for (const match of html.matchAll(/<link\b[^>]*>/gi)) {
            const tag = match[0];
            const href = (tag.match(/href="([^"]+)"/) || [])[1] || '';
            const rel = (tag.match(/rel="([^"]+)"/) || [])[1] || '';
            if (!/^https?:/.test(href)) continue;
            if (/stylesheet/.test(rel)) external.push({ kind: 'style-src', what: href });
            else if (/icon|apple-touch/.test(rel)) external.push({ kind: 'img-src', what: href });
            // preconnect/dns-prefetch ресурс не грузят — политике они не подчиняются
        }
        const notAllowed = external.filter((item) => !hostAllowed(meta.get(item.kind), item.what));
        ok(`каждый внешний файл разметки разрешён (проверено: ${external.length})`,
            notAllowed.length === 0,
            notAllowed.length ? notAllowed.map((item) => `${item.kind}: ${item.what}`).join(' | ') : '');

        ok('шрифт Google отдаётся с fonts.gstatic.com и разрешён в font-src',
            hostAllowed(meta.get('font-src'), 'https://fonts.gstatic.com'));

        const supabaseUrl = (read(CONFIG_JS).match(/SUPABASE_URL:\s*'([^']+)'/) || [])[1];
        ok('адрес базы из js/config.js разрешён в connect-src',
            !!supabaseUrl && hostAllowed(meta.get('connect-src'), supabaseUrl),
            supabaseUrl || 'не найден в js/config.js');
    }

    // --- 8. Инструменты: линтер, сборка, CI ------------------------------
    log('=== 8. Линтер, сборка и непрерывная интеграция ===');
    const eslint = read(ESLINT);
    ok('eslint.config.mjs запрещает встроенные обработчики (no-restricted-syntax)',
        /no-restricted-syntax/.test(eslint) && /on\(click\|/.test(eslint));

    let pkg = {};
    try { pkg = JSON.parse(read(PKG)); } catch { /* ниже скажем, что скриптов нет */ }
    ok('package.json: есть сборка CSS и линтер',
        !!(pkg.scripts && pkg.scripts.build && pkg.scripts.lint),
        Object.keys(pkg.scripts || {}).join(', '));
    ok('package.json: tailwindcss и eslint в devDependencies',
        !!(pkg.devDependencies && pkg.devDependencies.tailwindcss && pkg.devDependencies.eslint));
    ok('package-lock.json закоммичен (по нему CI ставит те же версии: npm ci)',
        fs.existsSync(LOCK));

    const workflow = read(WORKFLOW);
    const required = ['npm ci', 'npm run build', 'npm run lint', 'frontend-check.mjs',
        'migration-check.mjs', 'i18n-check.mjs', 'vat-check.mjs'];
    const missingInCi = required.filter((needle) => !workflow.includes(needle));
    ok('CI собирает CSS, линтует и гоняет прогоны без браузера',
        missingInCi.length === 0,
        missingInCi.length ? 'нет в .github/workflows/ci.yml: ' + missingInCi.join(', ') : 'ci.yml');
    ok('CI гоняет браузерные прогоны (Chrome поднимается в самом CI)',
        /setup-chrome|CHROME_PATH/.test(workflow) && /invoice-check\.mjs/.test(workflow));

    const ignoredLines = read(VERCEL_IGNORE).split(/\r?\n/).map((line) => line.trim());
    const appFiles = ['css/', 'js/', 'index.html', 'sw.js', 'manifest.json'];
    ok('.vercelignore не выкидывает файлы приложения с хостинга',
        !ignoredLines.some((line) => appFiles.includes(line)),
        ignoredLines.filter((line) => appFiles.includes(line)).join(', '));
    ok('.vercelignore не отправляет на хостинг node_modules и инструменты сборки',
        ignoredLines.includes('node_modules/') && ignoredLines.includes('src/'));

    log('--- ИТОГ ---');
    log(failed === 0
        ? `  ВСЁ ВЕРНО: Tailwind собран локально (${(css.length / 1024).toFixed(1)} КБ, версия ${version}), ` +
          'встроенных обработчиков нет, CSP включена, линтер и CI на месте'
        : '  не прошло проверок: ' + failed);
}

try {
    await main();
} catch (error) {
    log('ОШИБКА ПРОГОНА: ' + (error && error.stack ? error.stack : error));
    failed += 1;
} finally {
    const outDir = path.join(os.tmpdir(), 'rsk-fin');
    try {
        fs.mkdirSync(outDir, { recursive: true });
        fs.writeFileSync(path.join(outDir, 'frontend-check.txt'), report.join('\r\n'), 'utf8');
    } catch { /* нет доступа к %TEMP% — отчёт остаётся в консоли */ }

    process.exit(failed === 0 ? 0 : 1);
}

