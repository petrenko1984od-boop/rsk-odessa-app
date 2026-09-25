// =====================================================================
// TAILWIND — ИСТОЧНИКИ СБОРКИ И ОТПЕЧАТОК
// =====================================================================
// Что здесь: список файлов, из которых Tailwind берёт имена классов, и
// отпечаток их содержимого. Нужен двум местам:
//   * tools/build-css.mjs         — ставит отпечаток в готовый css/tailwind.css;
//   * tools/checks/frontend-check.mjs — сверяет: собранный CSS соответствует
//     текущей разметке, а не забыт после правки (класс добавили, сборку не
//     сделали — стилей у него нет; раньше такую ошибку ловил только глаз).
// =====================================================================

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// Корень репозитория: файл лежит в tools/
export const ROOT = path.resolve(import.meta.dirname, '..');

export const CONFIG_FILE = 'tailwind.config.js';
export const INPUT_FILE = 'src/tailwind.css';
export const OUTPUT_FILE = 'css/tailwind.css';

// Строка-отпечаток в собранном CSS: её ищет и сверяет frontend-check.mjs.
export const STAMP_PREFIX = 'rsk-tailwind-build';

/** Все файлы, участвующие в сборке (пути относительно корня, по возрастанию). */
export function listSources() {
    const jsDir = path.join(ROOT, 'js');
    const jsFiles = [];

    (function walk(dir) {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (entry.name.endsWith('.js')) jsFiles.push(path.relative(ROOT, full));
        }
    })(jsDir);

    return [CONFIG_FILE, INPUT_FILE, 'index.html', ...jsFiles.sort()];
}

/**
 * Короткий отпечаток (16 hex) содержимого исходников: любая правка разметки
 * или модулей меняет его, поэтому сборку видно как устаревшую.
 */
export function sourceFingerprint(files = listSources()) {
    const hash = crypto.createHash('sha256');
    for (const rel of files) {
        hash.update(rel);
        hash.update('\0');
        hash.update(fs.readFileSync(path.join(ROOT, rel)));
        hash.update('\0');
    }
    return hash.digest('hex').slice(0, 16);
}

/** Версия приложения из js/config.js (`APP: { VERSION: 'x.y.z' }`) — в отпечатке сборки. */
export function appVersion() {
    const text = fs.readFileSync(path.join(ROOT, 'js', 'config.js'), 'utf8');
    const match = text.match(/VERSION\s*:\s*'([^']+)'/);
    if (!match) throw new Error('js/config.js: не найдена версия приложения (APP.VERSION)');
    return match[1];
}
