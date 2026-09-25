// =====================================================================
// ЗАПУСК CHROME ДЛЯ БРАУЗЕРНЫХ ПРОГОНОВ (общий код четырёх прогонов)
// =====================================================================
// Кому: invoice-check.mjs, fin-workflow-check.mjs, scale-check.mjs и
// fin-fix-check.mjs. Они поднимают одинаковый headless Chrome и ждут от него
// порт отладки (CDP). Раньше этот код был скопирован в каждый прогон и в CI
// падал одинаково: Chrome стартовал, порт так и не открывался, и прогон
// уходил в 30-секундное ожидание «Chrome не поднялся». Хуже всего то, что
// причина была скрыта: вывод браузера уходил в `stdio: 'ignore'`.
//
// Почему на раннере GitHub Actions браузер может не подняться: Chrome там
// ставит задача `browser-actions/setup-chrome` — не системным пакетом, а в
// кэш инструментов, поэтому у него нет setuid-помощника песочницы. В Ubuntu
// 24.04 (раннер `ubuntu-latest`) непривилегированные user namespaces
// ограничены AppArmor, песочница не поднимается, и браузер выходит сразу
// после старта. В CI Chrome запускают с послаблениями: `--no-sandbox`,
// `--disable-setuid-sandbox`, `--disable-dev-shm-usage` (в контейнерах
// маленький /dev/shm) и `--disable-gpu`.
//
// Поэтому запуск идёт «лестницей»: сначала обычный — как на рабочей машине, и
// только если порт отладки не открылся — с послаблениями. Отчёт прогона
// говорит, какая попытка сработала, а вывод браузера сохраняется в
// `%TEMP%\rsk-fin\chrome-<прогон>-stderr.txt` (его забирает артефакт CI):
// причина отказа видна, а не угадывается.
// =====================================================================

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Путь к браузеру: в CI его задаёт CHROME_PATH (Chrome ставит сама задача). */
export const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';

/** Пауза: прогонам нужны короткие задержки между шагами. */
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Послабления песочницы: с ними Chrome запускают в CI (см. шапку).
const RELAXED_FLAGS = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu'
];

/**
 * Попытки запуска: сверху — «как на рабочей машине», ниже — послабления.
 *
 * `waitMs` — сколько ждать порт отладки. Исправный браузер отвечает за
 * секунды, поэтому ждать дольше смысла нет: лучше сразу перейти к следующей
 * попытке. Последняя попытка берёт простой `--headless` на случай, если
 * сборка браузера не понимает форму `--headless=new`.
 */
const ATTEMPTS = [
    { mode: 'обычный запуск', headless: '--headless=new', flags: [], waitMs: 8000 },
    { mode: 'с --no-sandbox', headless: '--headless=new', flags: RELAXED_FLAGS, waitMs: 20000 },
    { mode: 'с --no-sandbox и простым --headless', headless: '--headless', flags: RELAXED_FLAGS, waitMs: 15000 }
];

/** Файл вывода браузера — рядом с отчётами прогонов (`%TEMP%\rsk-fin`). */
function stderrFile(label) {
    const dir = path.join(os.tmpdir(), 'rsk-fin');
    fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, 'chrome-' + label + '-stderr.txt');
}

/** Хвост вывода браузера одной строкой: попадает в отчёт и в текст ошибки. */
function tail(file, lines = 6) {
    try {
        return fs.readFileSync(file, 'utf8').trim().split(/\r?\n/).slice(-lines).join(' | ');
    } catch {
        return '';
    }
}

/** Ответ Chrome о себе: он же — признак, что порт отладки открылся. */
async function cdpVersion(port) {
    const response = await fetch('http://127.0.0.1:' + port + '/json/version');
    return response.json();
}

/**
 * Ждёт порт отладки: браузер ответил — выходим; браузер умер или время
 * вышло — возвращаем null.
 */
async function waitForCdp(port, waitMs, isDead) {
    const deadline = Date.now() + waitMs;
    for (;;) {
        try {
            return await cdpVersion(port);
        } catch { /* браузер ещё не открыл порт */ }
        if (isDead() || Date.now() >= deadline) return null;
        await sleep(500);
    }
}

/**
 * Поднимает headless Chrome и ждёт, пока тот откроет порт отладки.
 *
 * @param {{ port: number, profile: string, windowSize?: string, label: string }} options
 *        port — порт CDP; profile — папка профиля (её готовит вызывающий
 *        прогон — на Windows прошлый процесс может держать папку, и у прогонов
 *        на это свой обходной путь); windowSize — «ширина,высота»; label — имя
 *        для файла вывода браузера.
 * @returns {Promise<{ child: import('node:child_process').ChildProcess,
 *                     version: object, browser: string, mode: string }>}
 *        child — живой браузер (прогон гасит его в конце), version — ответ
 *        CDP, browser — строка версии для отчёта, mode — сработавшая попытка.
 */
export async function launchChrome({ port, profile, windowSize = '1280,1000', label }) {
    const logFile = stderrFile(label);
    const tried = [];

    for (const attempt of ATTEMPTS) {
        // Профиль очищается перед КАЖДОЙ попыткой: после неудачного запуска
        // Chromium оставляет в папке lock-файлы, и следующая попытка на них
        // спотыкается. Ошибку удаления не поднимаем — папку может держать
        // система (Windows), а прогон не должен падать из-за профиля.
        try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* занята системой */ }

        fs.appendFileSync(logFile, '\n--- попытка: ' + attempt.mode + ' ---\n');
        const fd = fs.openSync(logFile, 'a');
        let spawnError = null;

        const child = spawn(CHROME, [
            attempt.headless, '--remote-debugging-port=' + port,
            '--user-data-dir=' + profile, '--no-first-run', '--no-default-browser-check',
            '--disable-extensions', '--window-size=' + windowSize,
            ...attempt.flags, 'about:blank'
        ], { stdio: ['ignore', 'ignore', fd] });

        // Без обработчика 'error' Node печатает свой стек и выходит: причина
        // («нет такого файла») теряется, а отчёт прогона не записывается.
        child.on('error', (error) => { spawnError = error; });

        const version = await waitForCdp(port, attempt.waitMs, () => spawnError !== null);
        try { fs.closeSync(fd); } catch { /* уже закрыт */ }

        if (version) {
            return {
                child,
                version,
                browser: version.Browser || 'версия неизвестна',
                mode: attempt.mode
            };
        }

        tried.push(attempt.mode + ' — ' + (spawnError
            ? 'браузер не запустился: ' + spawnError.message
            : 'порт отладки не открылся за ' + Math.round(attempt.waitMs / 1000) + ' с'));

        try { child.kill(); } catch { /* уже закрыт */ }
        // Пауза перед следующей попыткой: у убитого Chromium надо забрать порт
        // отладки и профиль, иначе следующая попытка споткнётся о них.
        await sleep(1000);
    }

    const output = tail(logFile);
    const message = 'Chrome не поднялся (' + CHROME + '). Попытки: ' + tried.join('; ') +
        '. Вывод браузера (' + logFile + '): ' + (output || 'пусто');

    // В CI текст ошибки видно ещё и в сводке задачи — не только в журнале.
    if (process.env.GITHUB_ACTIONS === 'true') console.log('::error::' + message.replace(/\r?\n/g, ' '));
    throw new Error(message);
}
