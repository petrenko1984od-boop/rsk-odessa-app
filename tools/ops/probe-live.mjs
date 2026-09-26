// =====================================================================
// Проба БОЕВОГО адреса (только Node, без зависимостей и без секретов)
// =====================================================================
// Зачем: CI гоняет проверки по РЕПОЗИТОРИЮ, а сотрудник работает с ХОСТИНГОМ.
// Между ними стоит шаг, которого CI не видит вовсе — сама выкладка. Именно
// там ломается то, что проверки уже прошло:
//
//   * хостинг отдаёт СТАРЫЙ css/tailwind.css (сборку сделали, закоммитить
//     забыли) — интерфейс теряет цвета, а ошибок нигде нет;
//   * у сотрудников установлен service worker со СТАРОЙ политикой CSP — файлы
//     библиотек приходят со статусом 504 (см. README → «Политика
//     Content-Security-Policy»): правится только переустановкой worker-а, то
//     есть поднятием SHELL_REVISION;
//   * файл оболочки не уехал на хостинг (.vercelignore) — приложение работает
//     ровно до закрытия вкладки, а потом не открывается без сети;
//   * боевой js/config.js смотрит не на ту базу (например, на staging).
//
// Эта проба задаёт хостингу те же вопросы, что глаз в DevTools (README →
// «Проверка после деплоя»), но делает это сама и возвращает код 1 при
// расхождении. Поэтому её используют три места:
//
//   * .github/workflows/post-deploy.yml — «дождись, пока выложится ЭТОТ
//     коммит» (ключ --wait): падение означает, что выкладка не доехала;
//   * .github/workflows/uptime.yml — «сайт жив» каждые 15 минут; при падении
//     открывается issue (см. ops/README.md → «Мониторинг»);
//   * руками: node tools/ops/probe-live.mjs https://адрес --wait=120
//
// Ожидания берутся ИЗ РЕПОЗИТОРИЯ (sw.js, js/config.js, css/tailwind.css), а
// не из аргументов: так проба не может «договориться» с хостингом и пропустить
// расхождение версий — именно его и надо поймать.
//
// Запуск (из любой папки):
//     node tools/ops/probe-live.mjs https://<адрес>
//     $env:SITE_URL='https://<адрес>'; node tools/ops/probe-live.mjs --wait=600
//     node tools/ops/probe-live.mjs https://<адрес> --json --skip-external
//
// Ключи:
//   --wait=<секунды>       повторять пробу, пока она не станет успешной
//   --json                 печатать итог одной строкой JSON (для скриптов)
//   --skip-shell           не проверять файлы офлайн-оболочки (быстрее)
//   --skip-external        не проверять CDN-файлы разметки (быстрее)
//   --timeout=<секунды>    сколько ждать ответа одного запроса (по умолчанию 20)
//   --allow-missing-url    если адреса нет — напечатать «пропуск» и выйти с 0
//                          (так workflow не падает до того, как админ завёл
//                          секрет SITE_URL)
//   --report=<файл>        дополнительно записать отчёт в этот файл
//                          (по умолчанию %TEMP%\freedom-fin\probe-live.txt)
//
// Код возврата: 0 — всё сошлось; 1 — есть замечания; 2 — нет адреса и не
// передан --allow-missing-url.
// =====================================================================

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = process.env.APP_ROOT
    ? path.resolve(process.env.APP_ROOT)
    : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// ---------------------------------------------------------------- АРГУМЕНТЫ

const argv = process.argv.slice(2);
const flags = new Map();
const positional = [];

for (const arg of argv) {
    const match = arg.match(/^--([^=]+)(?:=(.*))?$/);
    if (match) flags.set(match[1], match[2] === undefined ? 'true' : match[2]);
    else positional.push(arg);
}

const has = (name) => flags.has(name);
const num = (name, fallback) => {
    const value = Number(flags.get(name));
    return Number.isFinite(value) && value >= 0 ? value : fallback;
};

const siteArg = (positional[0] || process.env.SITE_URL || '').trim().replace(/\/+$/, '');
const waitSec = num('wait', 0);
const allowMissingUrl = has('allow-missing-url');
const asJson = has('json');
const reportPath = flags.get('report') || path.join(os.tmpdir(), 'freedom-fin', 'probe-live.txt');

const report = [];
const log = (...args) => { const line = args.join(' '); report.push(line); if (!asJson) console.log(line); };

let failed = 0;
const ok = (name, cond, extra = '') => {
    log((cond ? '  ok   ' : '  FAIL ') + name + (extra ? ' :: ' + extra : ''));
    if (!cond) failed += 1;
    return !!cond;
};

function finish(code) {
    try {
        fs.mkdirSync(path.dirname(reportPath), { recursive: true });
        fs.writeFileSync(reportPath, report.join('\r\n'), 'utf8');
    } catch { /* нет доступа к папке отчёта — отчёт остаётся в консоли */ }

    if (asJson) {
        console.log(JSON.stringify({
            url: siteArg || null,
            ok: failed === 0,
            failed,
            checks: report.filter((line) => /^ {2}(ok|FAIL) /.test(line)).length,
            failures: report.filter((line) => line.startsWith('  FAIL ')).map((line) => line.slice(7))
        }));
    }

    process.exit(code);
}

if (!siteArg) {
    log('Пропуск пробы: адрес сайта не задан. Передайте его аргументом или переменной ' +
        'SITE_URL (в GitHub — секрет SITE_URL, см. ops/README.md).');
    finish(allowMissingUrl ? 0 : 2);
}

const BASE = siteArg;
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');
const pick = (text, regex) => (text.match(regex) || [])[1] || '';

// --------------------------------------------------------- ОЖИДАНИЯ ИЗ РЕПО

function expectations() {
    const sw = read('sw.js');
    const config = read('js', 'config.js');
    const css = read('css', 'tailwind.css');
    const stamp = css.match(/\/\* freedom-tailwind-build v([0-9.]+) ([0-9a-f]{16}) \*\//);

    return {
        appVersion: pick(config, /VERSION\s*:\s*'([^']+)'/),
        supabaseUrl: pick(config, /SUPABASE_URL:\s*'([^']+)'/),
        revision: pick(sw, /const SHELL_REVISION = '([^']+)'/),
        swVersion: pick(sw, /const APP_VERSION = '([0-9.]+)'/),
        cssStamp: stamp ? { version: stamp[1], hash: stamp[2] } : null,
        // Файлы офлайн-оболочки из sw.js → APP_SHELL. './' из списка убран:
        // это сам index.html, его отдельно проверяет первый шаг.
        shell: [...sw.matchAll(/'(\.\/[^']+)'/g)]
            .map((match) => match[1])
            .filter((item) => item !== './')
    };
}

// ------------------------------------------------------------------- СЕТЬ

const TIMEOUT_MS = num('timeout', 20) * 1000;

/**
 * Запрос с таймаутом. Кэш обходим случайным параметром: у Vercel статика
 * раздаётся через CDN, и «свежий» файл иначе мог бы прийти из кэша точки
 * присутствия — проба проверяла бы не то, что задеплоено, а то, что лежало.
 */
async function get(url) {
    const bust = url + (url.includes('?') ? '&' : '?') + 'freedom-probe=' + Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
        const response = await fetch(bust, { redirect: 'follow', cache: 'no-store', signal: controller.signal });
        const body = await response.text();
        return { status: response.status, headers: response.headers, body, error: null };
    } catch (error) {
        const reason = error && error.name === 'AbortError'
            ? `нет ответа за ${TIMEOUT_MS / 1000} с`
            : String((error && error.message) || error);
        return { status: 0, headers: new Headers(), body: '', error: reason };
    } finally {
        clearTimeout(timer);
    }
}

/** Несколько запросов одновременно, но не лавиной: у хостинга есть лимиты. */
async function getAll(urls, limit = 6) {
    const result = new Map();
    let next = 0;

    const workers = Array.from({ length: Math.min(limit, urls.length) }, async () => {
        while (next < urls.length) {
            const url = urls[next++];
            result.set(url, await get(url));
        }
    });

    await Promise.all(workers);
    return result;
}

// -------------------------------------------------------------------- CSP

/** Директивы политики: имя → отсортированные источники (как в frontend-check). */
function cspDirectives(policy) {
    const map = new Map();
    for (const part of String(policy).split(';')) {
        const words = part.trim().split(/\s+/).filter(Boolean);
        if (!words.length) continue;
        const [name, ...sources] = words;
        map.set(name, sources.slice().sort().join(' '));
    }
    return map;
}

/** Разрешён ли адрес директивами политики (учёт 'self', '*' и '*.домен'). */
function hostAllowed(sources, url) {
    const list = String(sources || '').split(/\s+/).filter(Boolean);
    if (list.includes('*')) return true;

    let target;
    try {
        target = new URL(String(url), BASE);
    } catch {
        return false;
    }

    return list.some((source) => {
        if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(source)) return false;
        const allowed = new URL(source);
        if (allowed.protocol !== target.protocol) return false;
        if (allowed.hostname === target.hostname) return true;
        if (allowed.hostname.startsWith('*.')) return target.hostname.endsWith(allowed.hostname.slice(1));
        return false;
    });
}

// --------------------------------------------------------------- ОДНА ПРОБА


async function probe(expected) {
    log(`=== Проба боевого адреса ${BASE} ===`);
    log(`  ожидания из репозитория: версия ${expected.appVersion}, ревизия оболочки ${expected.revision}`);

    // --- 1. Страница и её политика --------------------------------------
    const page = await get(BASE + '/');
    ok('главная страница отвечает 200', page.status === 200, page.error || String(page.status));

    const html = page.body || '';
    ok('страница — это приложение (подключает ./css/tailwind.css)', html.includes('./css/tailwind.css'));
    // Именно тег script: слово «cdn.tailwindcss.com» встречается в разметке
    // в комментарии о том, почему Play CDN больше не используется.
    ok('страница не подключает Play CDN (cdn.tailwindcss.com)',
        !/<script[^>]+src="https:\/\/cdn\.tailwindcss\.com/.test(html));

    const metaPolicy = pick(html, /<meta http-equiv="Content-Security-Policy" content="([^"]+)"/);
    const headerPolicy = page.headers.get('content-security-policy') || '';
    ok('заголовок CSP приходит от хостинга (не только из разметки)', !!headerPolicy);

    if (headerPolicy) {
        const meta = cspDirectives(metaPolicy);
        const header = cspDirectives(headerPolicy);

        ok('script-src без unsafe-inline (внедрённый скрипт не выполнится)',
            !/\bunsafe-inline\b/.test(header.get('script-src') || ''));
        ok('connect-src разрешает адрес базы из js/config.js',
            hostAllowed(header.get('connect-src'), expected.supabaseUrl), expected.supabaseUrl);
        ok('connect-src разрешает Worker-прокси (*.workers.dev)',
            hostAllowed(header.get('connect-src'), 'https://probe.workers.dev'));
        ok('connect-src разрешает Supabase напрямую (*.supabase.co)',
            hostAllowed(header.get('connect-src'), 'https://probe.supabase.co'));

        // Эти четыре хоста — причина выпуска r3: без них service worker отдаёт
        // 504 вместо файла. Проверка живёт здесь, потому что политику worker-а
        // задаёт ЗАГОЛОВОК ответа (meta из index.html до него не доходит).
        for (const cdn of ['https://cdn.jsdelivr.net', 'https://cdnjs.cloudflare.com',
            'https://fonts.googleapis.com', 'https://fonts.gstatic.com']) {
            ok(`connect-src разрешает ${cdn} (worker не отдаст 504)`,
                hostAllowed(header.get('connect-src'), cdn));
        }

        if (metaPolicy) {
            const keys = new Set([...meta.keys(), ...header.keys()]);
            const diff = [...keys].filter((key) => meta.get(key) !== header.get(key));
            ok('политика в разметке совпадает с заголовком хостинга', diff.length === 0, diff.join(', '));
        }
    }

    // --- 2. Service worker ----------------------------------------------
    const sw = await get(BASE + '/sw.js');
    ok('sw.js отвечает 200', sw.status === 200, sw.error || String(sw.status));

    const liveVersion = pick(sw.body, /const APP_VERSION = '([0-9.]+)'/);
    const liveRevision = pick(sw.body, /const SHELL_REVISION = '([^']+)'/);
    const cacheControl = (sw.headers.get('cache-control') || '').toLowerCase();

    ok('версия в боевом sw.js совпадает с репозиторием', liveVersion === expected.swVersion,
        `на хостинге: ${liveVersion || '—'}, в репозитории: ${expected.swVersion}`);
    ok('ревизия оболочки (SHELL_REVISION) совпадает с репозиторием', liveRevision === expected.revision,
        `на хостинге: ${liveRevision || '—'}, в репозитории: ${expected.revision}`);
    ok('sw.js отдаётся без долгого кэша (иначе браузер не увидит новую ревизию)',
        !cacheControl || /max-age=0|no-cache|no-store/.test(cacheControl), cacheControl || 'заголовка нет');

    // --- 3. Манифест PWA -------------------------------------------------
    const manifest = await get(BASE + '/manifest.json');
    let manifestJson = null;
    try { manifestJson = JSON.parse(manifest.body); } catch { /* скажем об этом ниже */ }

    ok('manifest.json отвечает 200 и разбирается', manifest.status === 200 && !!manifestJson,
        manifest.error || String(manifest.status));
    ok('manifest.json: display = standalone (приложение ставится отдельным окном)',
        manifestJson?.display === 'standalone', String(manifestJson?.display));
    ok('manifest.json: имя и иконки заполнены',
        !!manifestJson?.name && Array.isArray(manifestJson?.icons) && manifestJson.icons.length >= 2,
        `иконок: ${manifestJson?.icons?.length ?? 0}`);

    if (Array.isArray(manifestJson?.icons) && manifestJson.icons.length) {
        const iconUrls = [...new Set(manifestJson.icons.map((icon) => new URL(icon.src, BASE + '/').href))];
        const icons = await getAll(iconUrls);
        const broken = [...icons.entries()].filter(([, response]) => response.status !== 200);
        ok(`иконки манифеста отвечают 200 (${icons.size} шт.)`, broken.length === 0,
            broken.map(([url, response]) => `${url}: ${response.status || response.error}`).join(', '));
    }


    // --- 4. Собранные стили ----------------------------------------------
    const css = await get(BASE + '/css/tailwind.css');
    const cssBytes = Buffer.byteLength(css.body || '', 'utf8');
    ok('css/tailwind.css отвечает 200', css.status === 200, css.error || String(css.status));
    ok('css/tailwind.css — собранный файл (20–80 КБ, без @tailwind)',
        cssBytes > 20000 && cssBytes < 80000 && !/@tailwind\s/.test(css.body || ''),
        `${(cssBytes / 1024).toFixed(1)} КБ`);

    if (expected.cssStamp) {
        const liveStamp = (css.body || '').match(/\/\* freedom-tailwind-build v([0-9.]+) ([0-9a-f]{16}) \*\//);
        ok('отпечаток боевых стилей совпадает с репозиторием (сборку не забыли)',
            !!liveStamp && liveStamp[1] === expected.cssStamp.version && liveStamp[2] === expected.cssStamp.hash,
            liveStamp
                ? `на хостинге: v${liveStamp[1]} ${liveStamp[2]}, в репозитории: v${expected.cssStamp.version} ${expected.cssStamp.hash}`
                : 'отпечатка нет — файл собран вручную');
    }

    // --- 5. Конфигурация приложения --------------------------------------
    const config = await get(BASE + '/js/config.js');
    const liveConfigVersion = pick(config.body, /VERSION\s*:\s*'([^']+)'/);
    const liveSupabase = pick(config.body, /SUPABASE_URL:\s*'([^']+)'/);

    ok('js/config.js отвечает 200', config.status === 200, config.error || String(config.status));
    ok('версия в боевом js/config.js совпадает с репозиторием',
        liveConfigVersion === expected.appVersion, `на хостинге: ${liveConfigVersion || '—'}`);
    ok('боевой адрес базы — тот же, что в репозитории', liveSupabase === expected.supabaseUrl,
        liveSupabase || '—');

    // --- 6. Оболочка целиком (файлы для офлайна) --------------------------
    if (!has('skip-shell')) {
        const urls = [...new Set(expected.shell)].map((item) => BASE + '/' + item.replace(/^\.\//, ''));
        const responses = await getAll(urls);
        const broken = [...responses.entries()].filter(([, response]) => response.status !== 200);
        ok(`вся офлайн-оболочка лежит на хостинге (${responses.size} файлов)`, broken.length === 0,
            broken.map(([url, response]) => `${url.replace(BASE + '/', '')}: ${response.status || response.error}`).join(', '));
    }

    // --- 7. Библиотеки и шрифт разметки ----------------------------------
    if (!has('skip-external')) {
        // Берём только то, что браузер ДЕЙСТВИТЕЛЬНО загружает: скрипты и
        // таблицы стилей. Ссылки-подсказки (preconnect, dns-prefetch) и
        // локальные ресурсы (иконки, манифест) сюда не попадают: у
        // `fonts.googleapis.com` без пути ответ 404, и это не поломка.
        const HINTS = ['preconnect', 'dns-prefetch', 'icon', 'apple-touch-icon', 'manifest'];
        const externals = [...new Set([
            ...[...html.matchAll(/<script[^>]+src="(https:\/\/[^"]+)"/g)].map((match) => match[1]),
            ...[...html.matchAll(/<link[^>]+>/g)]
                .filter((match) => !new RegExp(`rel="(${HINTS.join('|')})"`).test(match[0]))
                .map((match) => (match[0].match(/href="(https:\/\/[^"]+)"/) || [])[1])
                .filter(Boolean)
        ])];

        if (externals.length) {
            const responses = await getAll(externals);
            const broken = [...responses.entries()].filter(([, response]) => response.status !== 200);
            ok(`внешние файлы разметки отвечают 200 (${responses.size} шт.)`, broken.length === 0,
                broken.map(([url, response]) => `${url}: ${response.status || response.error}`).join(', '));
        } else {
            log('  (внешних файлов в разметке нет — проверять нечего)');
        }
    }
}

// ------------------------------------------------------------------ ЗАПУСК
// Проба повторяется, пока не сойдётся (--wait): после выкладки хостинг ещё
// несколько минут отдаёт сборку точки присутствия, и без ожидания workflow
// ругался бы на нормально работающий сайт.

const expected = expectations();
const deadline = Date.now() + waitSec * 1000;
let attempt = 0;

for (;;) {
    attempt += 1;
    failed = 0;
    if (waitSec) log(`--- проба ${attempt} (ждём выкладку до ${waitSec} с) ---`);

    await probe(expected);

    if (failed === 0) {
        log('--- ИТОГ ---');
        log(`  ВСЁ СОШЛОСЬ: ${BASE} отдаёт приложение v${expected.appVersion}-${expected.revision}, ` +
            'политика CSP разрешает базу и CDN, оболочка на месте');
        finish(0);
    }

    if (!waitSec || Date.now() + 10000 > deadline) {
        log('--- ИТОГ ---');
        log(`  не прошло проверок: ${failed}`);
        log(`  отчёт: ${reportPath}`);
        finish(1);
    }

    log(`  …пока не сошлось (${failed} замечаний), повтор через 10 с`);
    await new Promise((resolve) => setTimeout(resolve, 10000));
}
