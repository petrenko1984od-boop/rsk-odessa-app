// =====================================================================
// Прогон БЕЗ БРАУЗЕРА (только Node): ЭКСПЛУАТАЦИЯ И БЭКАПЫ
// =====================================================================
// Зачем: этап «Эксплуатация» состоит из того, ЧЕГО НЕ ВИДНО В ПРИЛОЖЕНИИ:
// задача проверки после выкладки, проба доступности, резервные копии, staging
// и журнал ошибок. Ломается такое молча и некстати:
//
//   * секрет назвали не так — задача «проходит», ничего не проверяя (самый
//     опасный вид поломки: уверенность вместо проверки);
//   * в workflow позвали скрипт, которого нет (выяснится в момент сбоя — то
//     есть когда задача и должна спасать);
//   * миграцию журнала применили, а код пишет в другую таблицу/команду — и
//     ошибки сотрудников не сохраняются никому не заметно;
//   * подняли SHELL_REVISION и забыли документы — инструкция «Проверка после
//     деплоя» отправляет админа искать кэш, которого нет;
//   * staging-конфигурация сделана так, что подставляет боевую базу.
//
// Проверки (8 групп):
//   1. все файлы эксплуатации на месте;
//   2. каждый скрипт разбирается (node --check);
//   3. workflow: триггеры (расписание), права, вызов наших скриптов, артефакты;
//   4. каждый секрет из workflow описан в ops/README.md — иначе его никто не
//      заведёт, и задача будет молча простаивать;
//   5. make-config.mjs не содержит адресов и ключей, и staging-конфиг
//      физически не может показать боевую базу;
//   6. журнал ошибок: SQL миграции и код согласованы (таблица, команда, поля);
//   7. имя кэша в sw.js совпадает с документами (ревизия не «потерялась»);
//   8. прогон подключён к CI и к npm-скриптам.
//
// Запуск:  node tools/checks/ops-check.mjs   (из папки tools/checks)
// Код возврата 1, если есть замечания. Отчёт: %TEMP%\rsk-fin\ops-check.txt.
// =====================================================================

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = process.env.APP_ROOT
    ? path.resolve(process.env.APP_ROOT)
    : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const report = [];
const log = (...args) => { const line = args.join(' '); report.push(line); console.log(line); };

let failed = 0;
const ok = (name, cond, extra = '') => {
    log((cond ? '  ok   ' : '  FAIL ') + name + (extra ? ' :: ' + extra : ''));
    if (!cond) failed += 1;
    return !!cond;
};

const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');
const exists = (...parts) => fs.existsSync(path.join(ROOT, ...parts));

// Что должно существовать (путь → зачем: это попадает в сообщение о поломке)
const REQUIRED = {
    'tools/ops/probe-live.mjs': 'проба боевого адреса (после выкладки и по расписанию)',
    'tools/ops/check-dump.mjs': 'проверка дампа резервной копии',
    'make-config.mjs': 'подстановка базы staging при сборке',
    'ops/README.md': 'инструкция: деплой, staging, бэкапы, мониторинг',
    'database/migrate-v2.9-ops-monitoring.sql': 'таблица и команда журнала ошибок',
    'js/monitoring.js': 'модуль журнала ошибок в приложении'
};

const WORKFLOWS = {
    'post-deploy.yml': 'проверка после выкладки',
    'uptime.yml': 'проба доступности по расписанию',
    'backup.yml': 'резервная копия базы'
};

/** Название кэша оболочки: по нему админ сверяет кэш в DevTools (README). */
function cacheName() {
    const sw = read('sw.js');
    const prefix = (sw.match(/const CACHE_PREFIX = '([^']+)'/) || [])[1] || 'rsk-odessa';
    const version = (sw.match(/const APP_VERSION = '([0-9.]+)'/) || [])[1] || '';
    const revision = (sw.match(/const SHELL_REVISION = '([^']+)'/) || [])[1] || '';
    return `${prefix}-v${version}-${revision}`;
}

async function main() {
    // --- 1. Файлы на месте -----------------------------------------------
    log('=== 1. Файлы эксплуатации на месте ===');
    for (const [file, why] of Object.entries(REQUIRED)) ok(`${file} — ${why}`, exists(file));
    for (const [file, why] of Object.entries(WORKFLOWS)) {
        ok(`.github/workflows/${file} — ${why}`, exists('.github', 'workflows', file));
    }

    // --- 2. Скрипты разбираются ------------------------------------------
    log('=== 2. Каждый скрипт разбирается (node --check) ===');
    for (const file of ['tools/ops/probe-live.mjs', 'tools/ops/check-dump.mjs',
        'make-config.mjs', 'js/monitoring.js']) {
        if (!exists(file)) continue;
        try {
            execFileSync(process.execPath, ['--check', path.join(ROOT, file)], { stdio: 'pipe' });
            ok(`${file} разбирается без ошибок`, true);
        } catch (error) {
            const text = String(error.stderr || error.stdout || error.message || error).split('\n')[0];
            ok(`${file} разбирается без ошибок`, false, text);
        }
    }


    // --- 3. Workflow: триггеры, права, вызовы ----------------------------
    log('=== 3. Задачи GitHub: триггеры, права, вызовы скриптов ===');
    const workflowText = {};

    for (const [file, why] of Object.entries(WORKFLOWS)) {
        if (!exists('.github', 'workflows', file)) continue;

        const text = read('.github', 'workflows', file);
        workflowText[file] = text;

        ok(`${file} (${why}): забирает репозиторий`, text.includes('actions/checkout@'));
        // Расписание нужно двум задачам из трёх: проба доступности и бэкап.
        // Проверка после выкладки запускается push-ом и расписания не имеет.
        const needsCron = file !== 'post-deploy.yml';
        ok(`${file}: расписание (cron) ${needsCron ? 'настроено' : 'не нужно — запуск по push'}`,
            needsCron ? /cron:/.test(text) : !/cron:/.test(text));
        ok(`${file}: можно запустить вручную (workflow_dispatch)`, text.includes('workflow_dispatch:'));
        ok(`${file}: отчёт сохраняется артефактом`, text.includes('actions/upload-artifact@'));
        ok(`${file}: браузер не поднимает (проба — обычные HTTP-запросы)`, !text.includes('setup-chrome'));

        // Каждый скрипт, который зовут из задачи, должен существовать: иначе
        // поломка выяснится ровно тогда, когда задача должна спасать.
        const called = [...new Set([...text.matchAll(/node\s+([\w./-]+\.mjs)/g)].map((match) => match[1]))];
        const missing = called.filter((item) => !exists(item));
        ok(`${file}: все вызванные скрипты существуют (${called.length})`, missing.length === 0, missing.join(', '));

        // Двоеточие внутри имени шага ломает YAML целиком (`- name: Сверка: …`):
        // GitHub молча не запустит задачу, а локально это видно только
        // разбором YAML. Проверяем то, что читается без зависимостей.
        const badNames = text.split(/\r?\n/)
            .map((line, index) => ({ line, index: index + 1 }))
            .filter(({ line }) => /^\s*name:\s*[^"'|\n]*:\s/.test(line));
        ok(`${file}: в именах шагов нет двоеточий (иначе YAML не разбирается)`,
            badNames.length === 0,
            badNames.map(({ line, index }) => `строка ${index}: ${line.trim()}`).join(' | '));

        // Пустой секрет должен давать предупреждение, а не «успешную» задачу:
        // поэтому у каждого секрета есть шаг проверки.
        const secrets = [...new Set([...text.matchAll(/secrets\.([A-Z_]+)/g)].map((match) => match[1]))]
            .filter((name) => name !== 'GITHUB_TOKEN');
        const hidden = secrets.filter((name) => !text.includes(`секрет ${name}`));
        ok(`${file}: у каждого секрета есть шаг проверки (${secrets.length})`, hidden.length === 0, hidden.join(', '));
    }

    const backup = workflowText['backup.yml'] || '';
    ok('backup.yml: дамп снимает Supabase CLI (версии клиента и сервера согласованы)',
        backup.includes('supabase/setup-cli@') && backup.includes('supabase db dump'));
    ok('backup.yml: дамп проверяется нашим прогоном', backup.includes('tools/ops/check-dump.mjs'));
    ok('backup.yml: архив хранится 90 дней (retention-days)', /retention-days:\s*90/.test(backup));
    ok('backup.yml: восстановление разворачивает дамп (download-artifact + psql)',
        backup.includes('actions/download-artifact@') && backup.includes('psql'));
    ok('backup.yml: неполное восстановление считается ошибкой (задача падает)',
        backup.includes('::error') && backup.includes('exit 1'));

    const uptime = workflowText['uptime.yml'] || '';
    ok('uptime.yml: права — чтение кода и запись issue',
        /permissions:[\s\S]*contents:\s*read[\s\S]*issues:\s*write/.test(uptime));
    ok('uptime.yml: о сбое сообщается в issue', uptime.includes('gh issue create'));
    ok('uptime.yml: проба не останавливает задачу (continue-on-error)',
        uptime.includes('continue-on-error: true'));
    ok('uptime.yml: проба идёт каждые 15 минут', /cron:\s*'\*\/15 /.test(uptime));

    const postDeploy = workflowText['post-deploy.yml'] || '';
    ok('post-deploy.yml: ждёт выкладку, а не проверяет сразу (--wait)',
        /probe-live\.mjs\s+--wait=\d+/.test(postDeploy));
    ok('post-deploy.yml: запускается на push в основную ветку',
        /push:[\s\S]*branches:\s*\[main/.test(postDeploy));

    // --- 4. Секреты описаны в инструкции ---------------------------------
    log('=== 4. Каждый секрет описан в ops/README.md ===');
    const opsDoc = exists('ops', 'README.md') ? read('ops', 'README.md') : '';
    const allSecrets = [...new Set(Object.values(workflowText)
        .flatMap((text) => [...text.matchAll(/secrets\.([A-Z_]+)/g)].map((match) => match[1])))]
        .filter((name) => name !== 'GITHUB_TOKEN');
    const undocumented = allSecrets.filter((name) => !opsDoc.includes(name));
    ok(`секреты задокументированы (${allSecrets.length} шт.)`, undocumented.length === 0, undocumented.join(', '));
    ok('ops/README.md объясняет, что бывает при незаданном секрете',
        /не задан|незаданн|предупреждени/i.test(opsDoc));

    // --- 5. Конфигурация окружений ---------------------------------------
    log('=== 5. staging-конфигурация не подставит боевую базу ===');
    const makeConfig = exists('make-config.mjs') ? read('make-config.mjs') : '';
    ok('make-config.mjs читает адрес и ключ из окружения',
        makeConfig.includes('process.env.SUPABASE_URL') && makeConfig.includes('process.env.SUPABASE_ANON_KEY'));
    ok('make-config.mjs не содержит адресов баз и ключей (файл публикуется как статика)',
        !/supabase\.co|workers\.dev|sb_publishable/.test(makeConfig));
    ok('make-config.mjs останавливает сборку без переменных окружения',
        /process\.exit\(1\)/.test(makeConfig));
    ok('make-config.mjs НЕ исключён .vercelignore (иначе сборка staging не найдёт его)',
        !read('.vercelignore').split(/\r?\n/).map((line) => line.trim()).includes('make-config.mjs'));

    const swText = exists('sw.js') ? read('sw.js') : '';
    const configJs = read('js', 'config.js');
    ok('js/config.js в репозитории — боевой (адрес через Worker-прокси)',
        configJs.includes('workers.dev'));
    ok('js/config.js в репозитории не ссылается на staging', !/staging/i.test(configJs));
    ok('make-config.mjs не попал в офлайн-оболочку (sw.js → APP_SHELL)',
        !swText.includes("'./make-config.mjs'"));
    ok('js/monitoring.js есть в офлайн-оболочке (иначе он не закэшируется)',
        swText.includes("'./js/monitoring.js'"));

    // --- 6. Журнал ошибок: миграция и код согласованы ---------------------
    log('=== 6. Журнал ошибок: миграция и код согласованы ===');
    const sql = exists('database', 'migrate-v2.9-ops-monitoring.sql')
        ? read('database', 'migrate-v2.9-ops-monitoring.sql') : '';
    const monitoring = exists('js', 'monitoring.js') ? read('js', 'monitoring.js') : '';

    ok('миграция: таблица app_errors создаётся с if not exists (повторный запуск безопасен)',
        /create table if not exists public\.app_errors/.test(sql));
    ok('миграция: команда записи создаётся через create or replace',
        /create or replace function public\.rsk_log_app_errors\(p_entries jsonb\)/.test(sql));
    ok('миграция: команда от владельца (security definer) и с фиксированным search_path',
        /security definer/.test(sql) && /set search_path = pg_catalog, public/.test(sql));
    ok('миграция: RLS включён на журнале',
        /alter table public\.app_errors enable row level security/.test(sql));
    ok('миграция: читают Администратор и Директор',
        /create policy rsk_app_errors_select_admin/.test(sql) && sql.includes("'Администратор', 'Директор'"));
    ok('миграция: прямые права у anon и authenticated отозваны',
        /revoke all on table public\.app_errors from anon/.test(sql)
        && /revoke all on table public\.app_errors from authenticated/.test(sql));
    ok('миграция: запись разрешена только вошедшим',
        /grant execute on function public\.rsk_log_app_errors\(jsonb\) to authenticated/.test(sql));
    ok('миграция: требует сначала v2.7.0 и говорит об этом понятно',
        sql.includes('Сначала примените database/migrate-v2.7-rls-finance.sql'));
    ok('миграция: просит PostgREST перечитать схему (notify pgrst)',
        /notify pgrst, 'reload schema'/.test(sql));
    ok('миграция: печатает самопроверку (ok / MISSING)',
        (sql.match(/then 'ok' else/g) || []).length >= 5,
        `строк проверки: ${(sql.match(/then 'ok' else/g) || []).length}`);
    ok('миграция: не удаляет данные (ни drop table, ни truncate)',
        !/drop table|truncate/i.test(sql));

    // Код и база должны называть ОДНО И ТО ЖЕ: иначе ошибки сотрудников уходят
    // «в никуда», и никто об этом не узнаёт — самый дорогой вид расхождения.
    ok('код зовёт ту же команду, что создаёт миграция',
        monitoring.includes("rpc('rsk_log_app_errors'") && sql.includes('function public.rsk_log_app_errors'));
    ok('код передаёт массив entries — как ждёт команда',
        /entries:/.test(monitoring) && /jsonb_array_elements\(p_entries\)/.test(sql));

    const FIELDS = ['app_version', 'shell_revision', 'kind', 'message', 'stack', 'page', 'user_agent', 'context'];
    const fieldsInCode = FIELDS.filter((field) => monitoring.includes(`${field}:`));
    const fieldsInSql = FIELDS.filter((field) => sql.includes(field));
    ok(`код заполняет все ${FIELDS.length} полей журнала`, fieldsInCode.length === FIELDS.length,
        FIELDS.filter((field) => !fieldsInCode.includes(field)).join(', '));
    ok(`миграция знает все ${FIELDS.length} полей журнала`, fieldsInSql.length === FIELDS.length,
        FIELDS.filter((field) => !fieldsInSql.includes(field)).join(', '));

    ok('журнал включается в точке входа (js/main.js → initMonitoring)',
        read('js', 'main.js').includes('initMonitoring()'));
    ok('журнал выключен на локальном адресе (прогоны с моком базы в боевую не пишут)',
        /localhost/.test(monitoring) && /disabledHere/.test(monitoring));
    ok('миграция журнала описана в документации базы',
        read('database', 'README.md').includes('migrate-v2.9-ops-monitoring.sql'));

    // --- 7. Ревизия оболочки и документы ----------------------------------
    log('=== 7. Имя кэша оболочки совпадает с документами ===');
    const name = cacheName();
    ok('имя кэша собирается из версии и ревизии', /^rsk-odessa-v[0-9.]+-\w+$/.test(name), name);

    const rootReadme = read('README.md');
    ok(`имя кэша ${name} упомянуто в README («Проверка после деплоя»)`, rootReadme.includes(name));
    ok('README объясняет, что правка кода или CSP требует поднять SHELL_REVISION',
        /SHELL_REVISION/.test(rootReadme) && /поднимите|поднять/.test(rootReadme));
    ok('README ссылается на ops/README.md (эксплуатация описана в одном месте)',
        rootReadme.includes('ops/README.md'));
    ok('ops/README.md описывает деплой, staging, копии и мониторинг',
        /## Деплой/.test(opsDoc) && /## Staging/.test(opsDoc)
        && /## Резервные копии/.test(opsDoc) && /## Мониторинг/.test(opsDoc));

    // --- 8. Прогон подключён к CI и npm -----------------------------------
    log('=== 8. Прогон подключён к CI и npm-скриптам ===');
    ok('CI запускает ops-check.mjs', read('.github', 'workflows', 'ci.yml').includes('ops-check.mjs'));

    const pkg = JSON.parse(read('package.json'));
    ok('npm run check включает ops-check', String(pkg.scripts.check).includes('ops-check.mjs'));
    ok('есть npm-скрипты check:ops и probe', !!(pkg.scripts['check:ops'] && pkg.scripts.probe));
    ok('npm run probe запускает пробу боевого адреса',
        String(pkg.scripts.probe).includes('probe-live.mjs'));
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
        fs.writeFileSync(path.join(outDir, 'ops-check.txt'), report.join('\r\n'), 'utf8');
    } catch { /* нет доступа к %TEMP% — отчёт остаётся в консоли */ }

    log('--- ИТОГ ---');
    log(failed === 0
        ? '  ВСЁ ВЕРНО: проба выкладки, резервные копии, staging-конфиг, журнал ошибок и документация на месте'
        : '  не прошло проверок: ' + failed);

    process.exit(failed === 0 ? 0 : 1);
}
