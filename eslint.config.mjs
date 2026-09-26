// =====================================================================
// ESLINT — ПРАВИЛА ДЛЯ ИСХОДНИКОВ ПРИЛОЖЕНИЯ (плоский конфиг, ESLint 9)
// =====================================================================
// Запуск:
//     npm run lint           (то же: npx eslint .)
//     npm run lint:fix
//
// Что здесь самое важное:
//   * `no-restricted-syntax` запрещает inline-обработчики в строках модулей
//     (`onclick="..."`) — их нельзя закрыть CSP без `script-src 'unsafe-inline'`
//     и они не видны проверкам. Вместо них `data-action` (js/actions.js).
//     Разметку (index.html) ESLint не читает — там то же правило стережёт
//     tools/checks/frontend-check.mjs;
//   * браузерные и серверные (Node) глобальные переменные разделены: иначе
//     `document` в инструментах или `process` в приложении считались бы
//     опечаткой (no-undef);
//   * sw.js живёт в отдельном окружении (Service Worker) — ему нужны
//     глобальные переменные и воркера, и браузера.
//
// Конфиг сознательно «не строгий по стилю»: в проекте свой стиль
// (4 пробела, точки с запятой, комментарии), и переписывать под правила
// линтера готовый код смысла нет. Линтер ловит ошибки, а не вкус.
// =====================================================================

import js from '@eslint/js';
import globals from 'globals';

// Текст совпадает с сообщением прогона frontend-check.mjs: искать надо по делу.
const INLINE_HANDLER_MESSAGE =
    'Inline-обработчик запрещён (CSP): вызывайте действие через data-action, см. js/actions.js';

const INLINE_HANDLER_PATTERN = String.raw`on(click|change|input|submit|keydown|keyup|keypress|error|load|blur|focus)\s*=`;

export default [
    {
        // Собранный CSS, зависимости и чужие мини-проекты не проверяем:
        // у них своя сборка и свои правила (pres-check — старый прогон
        // презентации, Смета — React+Vite и Prisma/Node на CommonJS), а наш
        // конфиг настроен на браузерные модули и только добавил бы им ложных
        // ошибок вида «require is not defined».
        ignores: [
            'node_modules/**',
            'tools/checks/node_modules/**',
            'pres-check/**',
            'Смета/**',
            'Документация/**',
            'css/tailwind.css'
        ]
    },

    js.configs.recommended,

    // ---- Исходники приложения: браузер, ES-модули ----
    {
        files: ['**/*.js', '**/*.mjs'],
        languageOptions: {
            ecmaVersion: 2023,
            sourceType: 'module',
            globals: {
                ...globals.browser,
                // Библиотеки подключены тегами <script> в index.html (с SRI):
                // в модулях они доступны как глобальные, линтеру об этом надо
                // сказать, иначе он видит опечатку там, где её нет.
                XLSX: 'readonly',        // выгрузки в Excel
                html2canvas: 'readonly', // снимок графика для PDF
                jspdf: 'readonly',       // PDF диаграммы Ганта
                Gantt: 'readonly'        // frappe-gantt
            }
        },
        rules: {
            // Встроенные обработчики в строках модулей: их нельзя закрыть CSP
            // без `script-src 'unsafe-inline'` и они не видны проверкам.
            'no-restricted-syntax': ['error',
                {
                    selector: `Literal[value=/${INLINE_HANDLER_PATTERN}/]`,
                    message: INLINE_HANDLER_MESSAGE
                },
                {
                    selector: `TemplateElement[value.raw=/${INLINE_HANDLER_PATTERN}/]`,
                    message: INLINE_HANDLER_MESSAGE
                }
            ],
            // Ошибки, которые в этом проекте действительно ловят опечатки.
            'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
            'no-cond-assign': 'error',
            eqeqeq: 'error',
            'no-implicit-globals': 'off',   // модули и так изолированы, а хелперы выставляются на window осознанно
            // Экранирование кавычек внутри строк осознанное: прогоны собирают из
            // этих строк JS-код для браузера (мок Supabase, вставки в страницу),
            // и «лишний» обратный слэш там нужен итоговому коду, а не нам.
            'no-useless-escape': 'off'
        }
    },

    // ---- Service worker: своё окружение ----
    {
        files: ['sw.js'],
        languageOptions: {
            globals: {
                ...globals.browser,
                ...globals.serviceworker
            }
        }
    },

    // ---- Инструменты (tools/**) и сборочный скрипт в корне: Node, .mjs ----
    // make-config.mjs лежит в корне осознанно: его зовёт сборка staging-проекта
    // Vercel, а папку tools/ на хостинг не отправляют (см. ops/README.md).
    {
        files: ['tools/**/*.mjs', 'tools/**/*.js', 'make-config.mjs'],
        languageOptions: {
            globals: {
                ...globals.node
            }
        },
        rules: {
            // Прогоны ОПИСЫВАЮТ запрещённую разметку (ищут `onclick="..."` в
            // файлах приложения), поэтому сам их текст содержит этот шаблон:
            // для tools/ правило про встроенные обработчики не работает.
            'no-restricted-syntax': 'off'
        }
    },

    // ---- Конфигурация сборки ----
    {
        files: ['tailwind.config.js', 'eslint.config.mjs'],
        languageOptions: {
            globals: {
                ...globals.node
            }
        }
    }
];
