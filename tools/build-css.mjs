// =====================================================================
// СБОРКА CSS ДЛЯ ПРОДА (Tailwind → css/tailwind.css)
// =====================================================================
// Запуск:
//     npm run build          (то же: node tools/build-css.mjs)
//
// Почему сборка, а не Play CDN: браузер больше не скачивает чужой скрипт
// `cdn.tailwindcss.com` и не генерирует стили на каждом устройстве — готовый
// файл лежит рядом с приложением, попадает в офлайн-кэш PWA (sw.js) и
// подчиняется CSP (`script-src` без внешних доменов).
//
// В готовый файл дописывается строка-отпечаток:
//     /* freedom-tailwind-build v2.9.0 1a2b3c4d5e6f7a8b */
// Её сверяет tools/checks/frontend-check.mjs: если после правки разметки
// сборку не сделали, отпечаток не совпадёт и прогон упадёт.
// =====================================================================

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
    CONFIG_FILE, INPUT_FILE, OUTPUT_FILE, ROOT, STAMP_PREFIX,
    appVersion, listSources, sourceFingerprint
} from './tailwind-sources.mjs';

const TAILWIND_CLI = path.join(ROOT, 'node_modules', 'tailwindcss', 'lib', 'cli.js');

/**
 * Собирает CSS и ставит отпечаток.
 * @param {{ output?: string, quiet?: boolean }} [options]
 *        output — куда положить (по умолчанию css/tailwind.css из конфига);
 *        quiet  — не печатать вывод Tailwind (нужно прогону проверок).
 * @returns {{ output: string, bytes: number, fingerprint: string, version: string }}
 */
export function buildCss({ output = OUTPUT_FILE, quiet = false } = {}) {
    if (!fs.existsSync(TAILWIND_CLI)) {
        throw new Error(
            'Нет пакета tailwindcss: выполните `npm install` в корне проекта, ' +
            'затем `npm run build`.'
        );
    }

    const args = [
        TAILWIND_CLI,
        '--config', CONFIG_FILE,
        '--input', INPUT_FILE,
        '--output', output,
        '--minify'
    ];

    const result = spawnSync(process.execPath, args, {
        cwd: ROOT,
        stdio: quiet ? ['ignore', 'ignore', 'inherit'] : 'inherit',
        // caniuse-lite отстаёт от браузеров; предупреждение к делу не относится
        env: { ...process.env, BROWSERSLIST_IGNORE_OLD_DATA: '1' }
    });

    if (result.status !== 0) {
        throw new Error(`Tailwind завершился с кодом ${result.status}`);
    }

    const target = path.join(ROOT, output);
    if (!fs.existsSync(target)) {
        throw new Error(`Tailwind не создал файл ${output}`);
    }

    const version = appVersion();
    const fingerprint = sourceFingerprint();
    const built = fs.readFileSync(target, 'utf8');

    // Отпечаток мог остаться от прошлой сборки — снимаем его перед записью.
    const withoutStamp = built.replace(
        new RegExp(`\\n?/\\* ${STAMP_PREFIX}[^*]*\\*/\\n?$`),
        '\n'
    );
    fs.writeFileSync(target, `${withoutStamp}/* ${STAMP_PREFIX} v${version} ${fingerprint} */\n`, 'utf8');

    return {
        output,
        bytes: fs.statSync(target).size,
        fingerprint,
        version
    };
}

// Запуск как команды (а не импорта из прогона проверок).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const files = listSources();
    const done = buildCss();
    console.log('');
    console.log(`✅ ${done.output} — ${(done.bytes / 1024).toFixed(1)} КБ, версия ${done.version}`);
    console.log(`   исходников в отпечатке: ${files.length}, отпечаток: ${done.fingerprint}`);
    console.log('   не забудьте закоммитить собранный css/tailwind.css.');
}
