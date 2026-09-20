// =====================================================================
// Прогон БЕЗ БРАУЗЕРА (только Node): проверка словаря языков js/i18n.js
// =====================================================================
// Зачем: интерфейс собирается из строк двумя способами — статичная разметка
// берёт перевод по ключу (`data-i18n="..."` в index.html), а модули — через
// `t('ключ')`. Если ключа нет в словаре, `t()` возвращает САМ КЛЮЧ: сотрудник
// видит в интерфейсе «order.paymentPending» вместо «⏳ Ожидает оплаты». Именно
// так ломались подписи оплаты в v2.4.0, и ошибку замечают уже на боевом
// приложении. Прогон стережёт:
//
//   1. все ключи, которые просит код (`t('...')`) и разметка (`data-i18n`),
//      есть и в русском, и в украинском словаре;
//   2. наборы ключей RU и UK совпадают (нет ключа, переведённого только для
//      одного языка — на другом он показался бы сырым ключом);
//   3. подстановки `{name}` в вызове `t('ключ', { name })` есть в тексте обоих
//      языков, иначе подстановка молча не сработает;
//   4. текст рядом с `data-i18n` в разметке совпадает со словарём (иначе при
//      переключении RU → UK → RU надпись «прыгает» на другую формулировку);
//   5. в словаре нет ключей-дублей.
//
// Лишние ключи (перевод есть, использования нет) — это примечание, а не
// ошибка: они не мешают работе.
//
// Запуск (из папки tools/checks):  node i18n-check.mjs
// Код возврата 1, если есть замечания — удобно для автопроверки перед выкладкой.
// =====================================================================
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = process.env.APP_ROOT
    ? path.resolve(process.env.APP_ROOT)
    : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const I18N = path.join(ROOT, 'js', 'i18n.js');
const INDEX = path.join(ROOT, 'index.html');
const JS_DIR = path.join(ROOT, 'js');

const report = [];
const log = (...args) => { const line = args.join(' '); report.push(line); console.log(line); };

let failed = 0;
const ok = (name, cond, extra = '') => {
    log((cond ? '  ok   ' : '  FAIL ') + name + (extra ? ' :: ' + extra : ''));
    if (!cond) failed += 1;
};

/** Весь код приложения, где встречается t('ключ'). */
function jsFiles(dir) {
    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...jsFiles(full));
        else if (entry.name.endsWith('.js') && full !== I18N) out.push(full);
    }
    return out;
}

/** Разбор словаря: ключ → текст для каждого языка + список дублей. */
function parseDict(source) {
    const dict = { ru: new Map(), uk: new Map() };
    const duplicates = [];

    for (const lang of ['ru', 'uk']) {
        const start = source.indexOf(`\n    ${lang}: {`);
        if (start === -1) continue;

        // Последний раздел словаря закрывается без запятой (`\n    }`), поэтому
        // ищем оба варианта — ошибка здесь оставила бы язык «пустым».
        let end = source.indexOf('\n    },', start);
        if (end === -1) end = source.indexOf('\n    }\n', start);
        if (end === -1) end = source.length;

        for (const line of source.slice(start, end).split(/\r?\n/)) {
            const m = line.match(/^\s{8}'([^']+)':\s*'(.*)',?\s*$/);
            if (!m) continue;
            const [, key, text] = m;
            if (dict[lang].has(key)) duplicates.push(`${lang}: ${key}`);
            dict[lang].set(key, text);
        }
    }

    return { dict, duplicates };
}

/** Ключи, которые просит код: t('ключ') и подстановки t('ключ', { name }). */
function usedKeys() {
    const keys = new Map();          // ключ → файлы, где он используется
    const params = [];               // { key, names, where }

    for (const file of jsFiles(JS_DIR)) {
        const text = fs.readFileSync(file, 'utf8');
        const where = path.relative(ROOT, file);

        for (const m of text.matchAll(/\bt\(\s*['"]([^'"]+)['"]/g)) {
            if (!keys.has(m[1])) keys.set(m[1], new Set());
            keys.get(m[1]).add(where);
        }

        for (const m of text.matchAll(/\bt\(\s*['"]([^'"]+)['"]\s*,\s*\{([^}]*)\}\s*\)/g)) {
            const names = [...m[2].matchAll(/([A-Za-z_$][\w$]*)\s*:/g)].map((x) => x[1]);
            if (names.length) params.push({ key: m[1], names, where });
        }
    }

    return { keys, params };
}

/**
 * Ключи из разметки: сам факт `data-i18n` и текст, который рядом с ним написан
 * (чтобы поймать расхождение между словарём и надписью в index.html).
 */
function keyedMarkup(html) {
    const keys = new Set();
    const inline = new Map();

    for (const m of html.matchAll(/data-i18n(?:-[\w-]+)?="([^"]*)"/g)) {
        if (m[1]) keys.add(m[1]);
    }

    for (const m of html.matchAll(/<[a-zA-Z][^>]*\sdata-i18n="([^"]+)"[^>]*>([^<]*)</g)) {
        const text = m[2].replace(/\s+/g, ' ').trim();
        if (text) inline.set(m[1], text);
    }

    return { keys, inline };
}


function main() {
    log('Проверка словаря языков: ' + path.relative(ROOT, I18N) + ' + ' + path.relative(ROOT, INDEX));

    if (!fs.existsSync(I18N)) {
        ok('файл словаря существует', false, I18N);
        return;
    }

    const source = fs.readFileSync(I18N, 'utf8');
    const { dict, duplicates } = parseDict(source);

    ok('словарь читается: есть русский и украинский разделы',
        dict.ru.size > 0 && dict.uk.size > 0,
        `ru: ${dict.ru.size} ключ(ей), uk: ${dict.uk.size} ключ(ей)`);

    ok('в словаре нет ключей-дублей', duplicates.length === 0, duplicates.join(', '));

    // --- 1. Ключи кода и разметки ---
    const { keys: codeKeys, params } = usedKeys();
    const html = fs.existsSync(INDEX) ? fs.readFileSync(INDEX, 'utf8') : '';
    const { keys: htmlKeys, inline } = keyedMarkup(html);

    const all = new Set([...codeKeys.keys(), ...htmlKeys]);
    const missingRu = [...all].filter((key) => !dict.ru.has(key));
    const missingUk = [...all].filter((key) => !dict.uk.has(key));

    ok('каждый ключ интерфейса есть в русском словаре',
        missingRu.length === 0, missingRu.join(', ') || `проверено ключей: ${all.size}`);

    ok('каждый ключ интерфейса есть в украинском словаре (иначе в UI виден сырой ключ)',
        missingUk.length === 0, missingUk.join(', ') || `проверено ключей: ${all.size}`);

    // --- 2. Наборы ключей двух языков совпадают ---
    const onlyRu = [...dict.ru.keys()].filter((key) => !dict.uk.has(key));
    const onlyUk = [...dict.uk.keys()].filter((key) => !dict.ru.has(key));
    ok('наборы ключей RU и UK совпадают',
        onlyRu.length === 0 && onlyUk.length === 0,
        [onlyRu.length ? 'только ru: ' + onlyRu.join(', ') : '',
            onlyUk.length ? 'только uk: ' + onlyUk.join(', ') : ''].filter(Boolean).join(' | '));

    // --- 3. Подстановки в вызовах t('ключ', { name }) ---
    const brokenParams = [];
    for (const { key, names, where } of params) {
        for (const lang of ['ru', 'uk']) {
            const text = dict[lang].get(key);
            if (text === undefined) continue;   // отсутствие ключа ловит проверка выше
            for (const name of names) {
                if (!text.includes(`{${name}}`)) brokenParams.push(`${where}: ${key} → {${name}} (${lang})`);
            }
        }
    }
    ok('подстановки {name} из вызовов t() есть в текстах обоих языков',
        brokenParams.length === 0, brokenParams.join(', '));

    // --- 4. Разметка не расходится со словарём ---
    const mismatched = [];
    for (const [key, text] of inline) {
        const ru = dict.ru.get(key);
        if (ru !== undefined && ru !== text) mismatched.push(`${key}: «${text}» ≠ «${ru}»`);
    }
    ok('текст рядом с data-i18n совпадает с русским словарём',
        mismatched.length === 0, mismatched.join(' | '));

    // --- 5. Примечание: ключи без использования ---
    const unused = [...dict.ru.keys()].filter((key) => !codeKeys.has(key) && !htmlKeys.has(key));
    if (unused.length) log('  note  ключи есть в словаре, но нигде не используются: ' + unused.join(', '));

    log('--- ИТОГ ---');
    log(failed === 0
        ? `  ВСЁ ВЕРНО: ${all.size} ключ(ей) интерфейса переведены на RU и UK, подстановки и разметка согласованы`
        : '  не прошло проверок: ' + failed);
}

try {
    main();
} catch (error) {
    log('ОШИБКА ПРОГОНА: ' + (error && error.stack ? error.stack : error));
    failed += 1;
} finally {
    const outDir = path.join(os.tmpdir(), 'rsk-fin');
    try {
        fs.mkdirSync(outDir, { recursive: true });
        fs.writeFileSync(path.join(outDir, 'i18n-check.txt'), report.join('\r\n'), 'utf8');
    } catch { /* нет доступа к %TEMP% — отчёт остаётся в консоли */ }

    process.exit(failed === 0 ? 0 : 1);
}
