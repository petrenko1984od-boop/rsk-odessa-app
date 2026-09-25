// =====================================================================
// RSK ODESSA — КОНФИГУРАЦИЯ ОКРУЖЕНИЯ ДЛЯ СБОРКИ (make-config.mjs)
// =====================================================================
// Зачем: у приложения две установки — боевая и staging (обкатка миграций и
// новых правок). База у них РАЗНАЯ, а подключается она из одного файла —
// js/config.js (`SUPABASE_URL`, `SUPABASE_ANON_KEY`). Держать в репозитории
// вторую копию файла нельзя: ветки разъедутся и правку придётся делать дважды.
//
// Поэтому staging-проект Vercel собирает js/config.js ЗАНОВО из своих
// переменных окружения, а боевой проект не собирает ничего — он отдаёт
// закоммиченный файл. Так боевой конфиг физически не может «уехать» на
// staging, а staging-адрес не попадает в git.
//
// Как это включается (пошагово — ops/README.md → «Staging-окружение»):
//   * в проекте Vercel для staging открыть Settings → Build & Development:
//       Build Command:   node make-config.mjs
//       Output Directory: .
//       Install Command: echo зависимостей нет
//     (Tailwind собирается заранее и лежит в репозитории, поэтому установка
//      пакетов на сборке не нужна);
//   * там же, Settings → Environment Variables, завести на окружение
//     Production/Preview: SUPABASE_URL и SUPABASE_ANON_KEY проекта staging;
//   * проверить сборку: в DevTools → Sources → js/config.js у staging-адреса
//     должен быть хост staging-базы, а не боевой.
//
// Если переменных нет — файл НЕ переписывается и сборка падает с понятным
// сообщением: молча отдать боевую базу staging-стенду было бы хуже всего
// (обкатка миграции пошла бы по боевым деньгам).
//
// ⚠️ Этот файл лежит в корне репозитория и поэтому попадает на хостинг как
//    обычная статика. Секретов в нём нет и быть не должно: он только ЧИТАЕТ
//    переменные окружения. Проверяет это прогон
//    tools/checks/ops-check.mjs (литералов ключа и адреса базы здесь нет).
//
// Запуск:
//     node make-config.mjs                  # переписать js/config.js (для сборки)
//     node make-config.mjs --check          # только показать, что будет заменено
//     node make-config.mjs --out=<файл>     # записать в другой файл (проверка)
// =====================================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = path.join(ROOT, 'js', 'config.js');

const argv = process.argv.slice(2);
const checkOnly = argv.includes('--check');
const flagValue = (name) => {
    const arg = argv.find((item) => item.startsWith(`--${name}=`));
    return arg ? arg.slice(name.length + 3) : '';
};
const target = path.resolve(ROOT, flagValue('out') || path.join('js', 'config.js'));

const fail = (message) => {
    console.error('❌ make-config: ' + message);
    process.exit(1);
};

const url = String(process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
const key = String(process.env.SUPABASE_ANON_KEY || '').trim();

if (!fs.existsSync(SOURCE)) fail(`не найден ${SOURCE}`);

const original = fs.readFileSync(SOURCE, 'utf8');
const urlLine = /(SUPABASE_URL:\s*')([^']*)(')/;
const keyLine = /(SUPABASE_ANON_KEY:\s*')([^']*)(')/;

if (!urlLine.test(original) || !keyLine.test(original)) {
    fail('в js/config.js не найдены строки SUPABASE_URL и SUPABASE_ANON_KEY — правил файл изменился');
}

/** Хост без пути: печатаем только его, ключ в отчёт не попадает никогда. */
const originOf = (value) => {
    if (!value) return '—';
    try { return new URL(value).origin; } catch { return 'не похоже на адрес'; }
};

if (checkOnly) {
    console.log('make-config --check:');
    console.log('  сейчас в файле:  ' + originOf(urlLine.exec(original)[2]));
    console.log('  из окружения:    ' + originOf(url));
    console.log('  ключ из окружения: ' + (key ? `задан (${key.length} символов)` : 'НЕ задан'));
    process.exit(0);
}

if (!url) fail('переменная SUPABASE_URL не задана — сборка staging не должна отдавать боевую базу');
if (!/^https:\/\/[a-z0-9.-]+$/i.test(url)) fail(`SUPABASE_URL должен быть адресом https без пути, получено: ${originOf(url)}`);
if (!key) fail('переменная SUPABASE_ANON_KEY не задана');
if (key.length < 20) fail(`SUPABASE_ANON_KEY подозрительно короткий (${key.length} символов) — проверьте переменную`);

const updated = original
    .replace(urlLine, (_, before, __, after) => before + url + after)
    .replace(keyLine, (_, before, __, after) => before + key + after);

fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, updated, 'utf8');

console.log('✅ make-config: подключение к базе подставлено из окружения');
console.log('   файл: ' + path.relative(ROOT, target).replace(/\\/g, '/'));
console.log('   база: ' + originOf(url));
console.log('   ключ: ' + key.length + ' символов, в отчёт не печатается');
