// =====================================================================
// Прогон БЕЗ БРАУЗЕРА (только Node): раздел «🔐 Доступы» (v2.12.0)
// =====================================================================
// Зачем. Экран собирает подписи прав ИЗ ДАННЫХ:
//     rightLabel(right) → LABELS[язык].rights[right] || right
// Прогон i18n-check такие обращения не видит — ключ складывается в рантайме,
// поэтому пропавшая подпись не всплыла бы нигде: сотрудник просто увидел бы
// «view_registry» вместо «Раздел «📊 Реестр»», а на украинском — русский текст.
// Этот прогон стережёт:
//
//   1. у КАЖДОЙ группы и КАЖДОГО права каталога (js/permissions.js →
//      PERMISSION_CATALOG) есть подпись и на русском, и на украинском, а
//      лишних подписей (право переименовали, строку забыли) нет;
//   2. каталог ПОКРЫВАЕТ заводскую матрицу: право, которое есть в
//      ROLE_PERMISSIONS, но не попало в каталог, администратор не увидит и не
//      снимет — ровно та ошибка, из-за которой и делался экран;
//   3. ни одно право не стоит в каталоге дважды (иначе в матрице две галочки на
//      одно право, и снятие одной оставляет вторую включённой);
//   4. служебные права (LOCKED_PERMISSIONS) есть в каталоге с подписями, и
//      ровно та роль, у которой есть право на этот экран, названа в политике
//      RLS миграции v2.12.0 — иначе экран выключал бы права роли, которой база
//      их менять не разрешает (или наоборот);
//   5. ПОВЕДЕНИЕ экрана и прав на «живых» модулях приложения (js/permissions.js
//      и js/modules/access.js) с заглушкой Supabase вместо настоящей базы:
//      · can() вычитает снятое право и прибавляет выданное, но не трогает
//        остальные;
//      · клетка матрицы — пустой квадратик или галочка: право можно и снять,
//        и ВЫДАТЬ (в пустой клетке), поэтому прочерка «—» на экране нет;
//      · строки о несуществующих ролях/правах не применяются и показываются
//        администратору предупреждением;
//      · служебное право и незнакомые значения экран в базу НЕ пишет (ни
//        выдачи, ни отзыва);
//      · запись уходит без changed_at/changed_by — их ставит триггер базы;
//      · галочка → черновик → «💾 Сохранить» → перечитывание → перерисовка:
//        снятая галочка видна на экране, а право сразу перестаёт работать;
//        поставленная в пустой клетке становится ВЫДАЧЕЙ (granted = true);
//      · «↩» у роли возвращает заводские права в обе стороны;
//      · без таблицы в базе экран говорит, какой файл применить, и не даёт
//        сохранить правки; таблица без колонки granted — тоже (её файл v2.12.0
//        применяли первой версией, только с отзывом);
//      · роль не попадает в раздел, который у неё закрыт (getStartTab).
//
// Запуск (из папки tools/checks):  node access-check.mjs
// Код возврата 1, если есть замечания — удобно для автопроверки перед выкладкой.
// =====================================================================
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = process.env.APP_ROOT
    ? path.resolve(process.env.APP_ROOT)
    : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const PERMISSIONS_JS = path.join(ROOT, 'js', 'permissions.js');
const ACCESS_JS = path.join(ROOT, 'js', 'modules', 'access.js');
const MIGRATION_SQL = path.join(ROOT, 'database', 'migrate-v2.12-role-permissions.sql');

const report = [];
const log = (...args) => { const line = args.join(' '); report.push(line); console.log(line); };

let failed = 0;
const ok = (name, cond, extra = '') => {
    log((cond ? '  ok   ' : '  FAIL ') + name + (extra ? ' :: ' + extra : ''));
    if (!cond) failed += 1;
};

const sortedList = (arr) => [...arr].map(String).sort().join(', ');

// Сбой в самом прогоне (а не в приложении) не должен прятаться и не должен
// обрывать отчёт: пишем ошибку в него и выходим с кодом 1.
for (const event of ['uncaughtException', 'unhandledRejection']) {
    process.on(event, (error) => {
        log('ОШИБКА ПРОГОНА: ' + (error && error.stack ? error.stack : error));
        failed += 1;
        process.exitCode = 1;
    });
}

// =====================================================================
// РАЗБОР КАТАЛОГА, МАТРИЦЫ И ПОДПИСЕЙ (без запуска модулей)
// =====================================================================

const permissionsSource = fs.readFileSync(PERMISSIONS_JS, 'utf8').replace(/\r\n/g, '\n');
const accessSource = fs.readFileSync(ACCESS_JS, 'utf8').replace(/\r\n/g, '\n');

/** Группы каталога: [{ id, rights: [...] }]. */
function parseCatalog(source) {
    const block = sliceBetween(source, 'export const PERMISSION_CATALOG = [', '\n];');
    const groups = [];
    // Между `{` и `id:` бывает комментарий (группа «system»), поэтому ищем по
    // самому `id`, а не по началу объекта.
    for (const match of block.matchAll(/\bid:\s*'([a-z_]+)',\s*rights:\s*\[([\s\S]*?)\]/g)) {
        groups.push({
            id: match[1],
            rights: [...match[2].matchAll(/'([a-z_]+)'/g)].map((m) => m[1])
        });
    }
    return groups;
}

const catalog = parseCatalog(permissionsSource);
const catalogRights = catalog.flatMap((group) => group.rights);
const catalogGroupIds = catalog.map((group) => group.id);

/** Все права заводской матрицы ROLE_PERMISSIONS — по всем ролям сразу. */
function parseMatrixRights(source) {
    const block = sliceBetween(source, 'const ROLE_PERMISSIONS = {', '\n};');
    return [...new Set([...block.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]))];
}

/** Права, которые матрица выдаёт конкретной роли. */
function parseMatrixRole(source, role) {
    const block = sliceBetween(source, 'const ROLE_PERMISSIONS = {', '\n};');
    const body = sliceBetween(block, `'${role}': [`, ']');
    return [...new Set([...body.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]))];
}

/** Роли, у которых в матрице есть какая-нибудь запись. */
function parseRoles(source) {
    const block = sliceBetween(source, 'const ROLE_PERMISSIONS = {', '\n};');
    return [...block.matchAll(/^\s{4}'([^']+)':\s*\[/gm)].map((m) => m[1]);
}

const matrixRights = parseMatrixRights(permissionsSource);
const matrixRoles = parseRoles(permissionsSource);

const lockedRights = [...(sliceBetween(permissionsSource, 'export const LOCKED_PERMISSIONS = [', ']')
    .matchAll(/'([a-z_]+)'/g))].map((m) => m[1]);

/** Строки одного языкового блока LABELS из js/modules/access.js. */
function parseLabels(source, lang) {
    const block = sliceBetween(source, `\n    ${lang}: {`, '\n    }\n');
    const entries = (text) => new Map([...text.matchAll(
        /^\s+([a-z_]+):\s*'([^']*)',?\s*$/gm)].map((m) => [m[1], m[2]]));

    return {
        groups: entries(sliceBetween(block, 'groups: {', '}')),
        rights: entries(sliceBetween(block, 'rights: {', '}'))
    };
}

const labels = { ru: parseLabels(accessSource, 'ru'), uk: parseLabels(accessSource, 'uk') };

// =====================================================================
// 1. ПОДПИСИ: КАЖДОЙ ГРУППЕ И КАЖДОМУ ПРАВУ — НА ОБОИХ ЯЗЫКАХ
// =====================================================================
log('── Подписи экрана «🔐 Доступы» (js/modules/access.js → LABELS) ──');

ok('каталог прав найден (групп >= 8, прав >= 30)',
    catalog.length >= 8 && catalogRights.length >= 30,
    `групп: ${catalog.length}, прав: ${catalogRights.length}`);

for (const lang of ['ru', 'uk']) {
    const missingGroups = catalogGroupIds.filter((id) => !labels[lang].groups.has(id));
    const extraGroups = [...labels[lang].groups.keys()].filter((id) => !catalogGroupIds.includes(id));
    const missingRights = catalogRights.filter((right) => !labels[lang].rights.has(right));
    const extraRights = [...labels[lang].rights.keys()].filter((right) => !catalogRights.includes(right));

    ok(`подписи ${lang.toUpperCase()}: у каждой группы каталога есть название, лишних нет`,
        missingGroups.length === 0 && extraGroups.length === 0,
        missingGroups.length || extraGroups.length
            ? `нет: ${sortedList(missingGroups) || '—'}; лишние: ${sortedList(extraGroups) || '—'}`
            : `групп: ${catalogGroupIds.length}`);

    ok(`подписи ${lang.toUpperCase()}: у каждого права каталога есть название, лишних нет`,
        missingRights.length === 0 && extraRights.length === 0,
        missingRights.length || extraRights.length
            ? `нет: ${sortedList(missingRights) || '—'}; лишние: ${sortedList(extraRights) || '—'}`
            : `прав: ${catalogRights.length}`);
}

// Русская и украинская подписи одного права не должны совпадать слово в слово:
// чаще всего это забытый перевод. Подписи-только-эмодзи не считаем (у групп).
const sameRightText = catalogRights.filter((right) => {
    const ru = String(labels.ru.rights.get(right) || '');
    const uk = String(labels.uk.rights.get(right) || '');
    return ru !== '' && ru === uk;
});

ok('подписи UK отличаются от RU (перевод не забыт ни у одного права)',
    labels.uk.rights.size > 0 && sameRightText.length === 0,
    sameRightText.length ? sortedList(sameRightText) : `проверено прав: ${catalogRights.length}`);

// =====================================================================
// 2. КАТАЛОГ И ЗАВОДСКАЯ МАТРИЦА — ОДИН И ТОТ ЖЕ НАБОР ПРАВ
// =====================================================================
log('');
log('── Каталог прав и заводская матрица (js/permissions.js) ──');

const notInCatalog = matrixRights.filter((right) => !catalogRights.includes(right));
const notInMatrix = catalogRights.filter((right) => !matrixRights.includes(right));

// Право матрицы, которого нет в каталоге, экран не покажет ни в одной строке —
// администратор не сможет его снять. Это и есть ошибка, ради которой делался
// экран, поэтому прогон её стережёт. Обратный случай (право каталога, которого
// нет ни у одной роли) безвреден: строка «—» во всех колонках.
ok('каждое право заводской матрицы есть в каталоге (его можно снять)',
    notInCatalog.length === 0,
    notInCatalog.length ? `нет в каталоге: ${sortedList(notInCatalog)}` : `прав матрицы: ${matrixRights.length}`);

ok('в каталоге нет прав, которых не выдаёт ни одна роль',
    notInMatrix.length === 0,
    notInMatrix.length ? `лишние в каталоге: ${sortedList(notInMatrix)}` : 'наборы прав совпадают');

const catalogDuplicates = catalogRights.filter((right, i) => catalogRights.indexOf(right) !== i);
ok('ни одно право не стоит в каталоге дважды',
    catalogDuplicates.length === 0,
    catalogDuplicates.length ? sortedList([...new Set(catalogDuplicates)]) : `проверено прав: ${catalogRights.length}`);

ok('служебное право (LOCKED_PERMISSIONS) есть и в каталоге, и в матрице',
    lockedRights.length === 1 && catalogRights.includes(lockedRights[0]) && matrixRights.includes(lockedRights[0]),
    `LOCKED_PERMISSIONS: ${sortedList(lockedRights) || '—'}`);

// Экран доступен ролям, которым право manage_access выдано в коде, а база пускает
// менять права только роли из политики RLS миграции. Если это разные роли,
// «💾 Сохранить» работала бы, а база отклоняла записи.
const migrationSql = fs.readFileSync(MIGRATION_SQL, 'utf8');
const policyRole = (migrationSql.match(/rsk_current_employee_role\(\)\s*=\s*'([^']+)'/) || [])[1] || '';
const rolesWithAccess = matrixRoles.filter((role) => parseMatrixRole(permissionsSource, role).includes('manage_access'));

ok('право на экран выдано одной роли, и это та же роль, что в политике RLS',
    rolesWithAccess.length === 1 && policyRole === rolesWithAccess[0],
    `право manage_access: ${sortedList(rolesWithAccess) || '—'}; политика RLS: ${policyRole || '—'}`);

ok('TAB_REQUIREMENTS: раздел «access» открывается правом manage_access',
    /'access':\s*'manage_access'/.test(permissionsSource));

// Импорт имени, которого в модуле нет, роняет ВЕСЬ граф модулей браузера: файл
// js/main.js импортирует раздел доступов статически, поэтому приложение не
// открывалось бы вовсе (так и было в первой сборке v2.12.0: js/modules/access.js
// просил getPermissionCatalog, а js/permissions.js его не экспортировал).
// Проверяем все обращения к модулю прав во всех файлах js/**.
function jsFiles(dir) {
    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...jsFiles(full));
        else if (entry.name.endsWith('.js')) out.push(full);
    }
    return out;
}

const exportedNames = new Set([
    ...[...permissionsSource.matchAll(/^export (?:async )?(?:function|const|let|class)\s+([A-Za-z_$][\w$]*)/gm)]
        .map((match) => match[1]),
    ...[...permissionsSource.matchAll(/^export \{([^}]*)\}/gm)]
        .flatMap((match) => match[1].split(',').map((name) => name.trim().split(/\s+as\s+/)[0].trim()))
]);

const brokenImports = [];
for (const file of jsFiles(path.join(ROOT, 'js'))) {
    const source = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
    for (const match of source.matchAll(/import\s*\{([^}]*)\}\s*from\s*'([^']*permissions\.js)'/g)) {
        for (const raw of match[1].split(',')) {
            const name = raw.trim().split(/\s+as\s+/)[0].trim();
            if (name && /^[A-Za-z_$][\w$]*$/.test(name) && !exportedNames.has(name)) {
                brokenImports.push(`${path.relative(ROOT, file).replace(/\\/g, '/')} → ${name}`);
            }
        }
    }
}

ok('все обращения к js/permissions.js просят то, что он действительно экспортирует',
    brokenImports.length === 0,
    brokenImports.length ? brokenImports.join(', ') : `проверено имён экспорта: ${exportedNames.size}`);


function sliceBetween(text, from, to) {
    const start = text.indexOf(from);
    if (start === -1) return '';
    const end = text.indexOf(to, start + from.length);
    return end === -1 ? '' : text.slice(start, end);
}

// =====================================================================
// 3. ПОВЕДЕНИЕ: «ЖИВЫЕ» МОДУЛИ С ЗАГЛУШКОЙ SUPABASE ВМЕСТО БАЗЫ
// =====================================================================
log('');
log('── Поведение прав и экрана (js/permissions.js + js/modules/access.js) ──');

// js/config.js создаёт клиент Supabase сразу при загрузке, js/utils.js вешает
// обработчики сети, toast() создаёт узел в document. Подставляем минимум, чтобы
// модули приложения загрузились, а вместо базы — заглушку, которая запоминает
// запросы и отдаёт то, что в неё положили. Настоящая база для этого прогона не
// нужна (поведение самих политик RLS проверяет migration-run-check.mjs).
const fake = { tables: {}, calls: [], fail: null };

/** Ответ заглушки на запрос: как PostgREST — { data, error }. */
function builder(table, op, payload) {
    const call = { table, op, payload: payload === undefined ? null : payload, filters: {}, single: false };
    fake.calls.push(call);

    const matches = (rows) => rows.filter((row) =>
        Object.entries(call.filters).every(([key, value]) => row[key] === value));

    const api = {
        select: () => api,
        eq(key, value) { call.filters[key] = value; return api; },
        in(key, value) { call.filters[key] = value; return api; },
        not: () => api,
        order: () => api,
        limit: () => api,
        maybeSingle() { call.single = true; return api; },
        single() { call.single = true; return api; },
        then: (onOk, onFail) => api.run().then(onOk, onFail),

        async run() {
            if (fake.fail && fake.fail.table === table) {
                return { data: null, error: { message: fake.fail.message } };
            }

            const rows = fake.tables[table] || (fake.tables[table] = []);

            if (op === 'select') {
                const picked = matches(rows);
                return { data: call.single ? (picked[0] ?? null) : picked, error: null };
            }

            // Триггер базы сам ставит «кто и когда» — заглушка делает то же,
            // чтобы в проверке было видно: клиент этих полей НЕ отправляет.
            const stamp = { changed_at: new Date().toISOString(), changed_by: 7 };

            if (op === 'insert') {
                const list = (Array.isArray(payload) ? payload : [payload]).map((row) => ({ ...row, ...stamp }));
                rows.push(...list);
                return { data: call.single ? list[0] : list, error: null };
            }

            if (op === 'update') {
                const touched = matches(rows);
                touched.forEach((row) => Object.assign(row, payload, stamp));
                return { data: call.single ? (touched[0] ?? null) : touched, error: null };
            }

            return { data: null, error: null };
        }
    };

    return api;
}


/** Узлы «документа»: разметку пишем в innerHTML, содержимое читаем в проверках. */
const elements = new Map();
const createdNodes = [];
function elementFor(id) {
    if (!elements.has(id)) {
        elements.set(id, {
            id,
            innerHTML: '',
            textContent: '',
            disabled: false,
            dataset: {},
            classList: {
                toggle() {}, add() {}, remove() {},
                contains: () => false
            }
        });
    }
    return elements.get(id);
}

globalThis.window = {
    addEventListener() {},
    supabase: {
        createClient: () => ({
            auth: { getUser: async () => ({ data: { user: { id: 'user-1' } }, error: null }) },
            from: (table) => ({
                select: () => builder(table, 'select'),
                insert: (payload) => builder(table, 'insert', payload),
                update: (payload) => builder(table, 'update', payload),
                delete: () => builder(table, 'delete')
            })
        })
    }
};
globalThis.document = {
    addEventListener() {},
    getElementById: (id) => elementFor(id),
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => {
        const node = elementFor('@node-' + createdNodes.length);
        createdNodes.push(node);
        return node;
    },
    body: { appendChild() {} },
    head: { appendChild() {} }
};
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.requestAnimationFrame = (cb) => cb();
try {
    // В свежих Node (21+) navigator объявлен только для чтения — подставить своё
    // значение нельзя, но и не нужно: isOnline() в этом прогоне не вызывается.
    globalThis.navigator = globalThis.navigator || { onLine: true };
} catch { /* navigator только для чтения — это нормально */ }

/** Выполняет шаг модуля приложения, не засоряя отчёт его служебным логом. */
async function quiet(fn) {
    const saveLog = console.log;
    const saveWarn = console.warn;
    const saveError = console.error;
    console.log = () => {};
    console.warn = () => {};
    console.error = () => {};
    try {
        return await fn();
    } finally {
        console.log = saveLog;
        console.warn = saveWarn;
        console.error = saveError;
    }
}

const perms = await quiet(() => import(pathToFileURL(PERMISSIONS_JS).href));
const access = await quiet(() => import(pathToFileURL(ACCESS_JS).href));

// ---------------------------------------------------------------------
// 3.1. База без таблицы: права работают по коду, сохранять нечего
// ---------------------------------------------------------------------
// Так выглядит приложение до того, как администратор применил
// database/migrate-v2.12-role-permissions.sql: чтение таблицы отвечает
// PGRST205. Экран обязан назвать файл и погасить «💾 Сохранить», а права —
// работать по заводской матрице. Пока таблицы нет, хранилище пустое: ни
// выданных, ни снятых прав, поэтому поведение роли ровно такое, как в коде.
const ROLE = 'Администратор';
const PLAIN = 'view_employees';      // право, которое не меняли
const REVOKED = 'add_employee';      // право, которое снимем
const CLOSED = 'close_section';      // права у этой роли нет: его ВЫДАДИМ

fake.fail = { table: 'role_permissions', message: "Could not find the table 'public.role_permissions' in the schema cache" };
fake.tables.employees = [{ id: 7, position: ROLE, status: 'active', user_id: 'user-1' }];
fake.tables.role_permissions = [];

await quiet(() => perms.loadPermissions());
await quiet(() => access.loadAccess());

const warning = (elements.get('access-warning') || elementFor('access-warning')).innerHTML;
const warningNow = () => (elements.get('access-warning') || elementFor('access-warning')).innerHTML;
const saveButton = () => elements.get('access-save-btn') || elementFor('access-save-btn');

ok('без таблицы в базе экран называет файл миграции и работает по коду',
    perms.getPermissionStore().reason === 'no_table' &&
    warning.includes('migrate-v2.12-role-permissions.sql') &&
    perms.can(REVOKED) === true && perms.can(CLOSED) === false,
    `причина: ${perms.getPermissionStore().reason}; can(${REVOKED}) = ${perms.can(REVOKED)}; can(${CLOSED}) = ${perms.can(CLOSED)}`);

access.toggleAccessRight({ target: { dataset: { arg: `${ROLE}|${PLAIN}` }, checked: false } });

ok('без таблицы «💾 Сохранить» гаснет: сохранять правки некуда',
    saveButton().disabled === true,
    `кнопка выключена: ${saveButton().disabled}`);

access.revertAccessDraft();

// Таблица есть, а колонки granted в ней нет: файл v2.12.0 применяли первой
// версией — тогда экран умел только отзывать права. Экран обязан сказать, что
// применить файл заново, и не давать сохранять: иначе выдача молча не запишется.
fake.fail = { table: 'role_permissions', message: 'column role_permissions.granted does not exist' };
await quiet(() => access.loadAccess());

ok('таблица без колонки granted: экран называет причину и не даёт сохранять',
    perms.getPermissionStore().reason === 'no_column' &&
    warningNow().includes('granted') && saveButton().disabled === true,
    `причина: ${perms.getPermissionStore().reason}, кнопка выключена: ${saveButton().disabled}`);

fake.fail = null;

// ---------------------------------------------------------------------
// 3.2. Права: заводская матрица, отзыв и выдача из базы
// ---------------------------------------------------------------------

fake.tables.employees = [{ id: 7, position: ROLE, status: 'active', user_id: 'user-1' }];
fake.tables.role_permissions = [];

await quiet(() => perms.loadPermissions());

ok('права прочитаны: роль взята из карточки сотрудника, правок в базе нет',
    perms.getRole() === ROLE && perms.getPermissionStore().read === true &&
    perms.getPermissionStore().rows === 0,
    `роль: ${perms.getRole() || '—'}, строк правок: ${perms.getPermissionStore().rows}`);

ok('без правок can() работает по заводской матрице',
    perms.can(PLAIN) === true && perms.can('manage_access') === true);

fake.tables.role_permissions = [
    { role: ROLE, permission: REVOKED, revoked: true, changed_at: '2026-09-01T10:00:00Z', changed_by: 7 }
];
const readBack = await quiet(() => perms.loadPermissionOverrides());

ok('отзыв из базы снимает право, соседние права не трогает',
    readBack.ok === true && perms.can(REVOKED) === false && perms.can(PLAIN) === true,
    `can(${REVOKED}) = ${perms.can(REVOKED)}, can(${PLAIN}) = ${perms.can(PLAIN)}`);

ok('getRolePermissions() и getAllPermissions() отдают права без снятого',
    !perms.getRolePermissions(ROLE).includes(REVOKED) &&
    perms.getRolePermissions(ROLE).includes(PLAIN) &&
    !perms.getAllPermissions().includes(REVOKED),
    `прав у роли: ${perms.getRolePermissions(ROLE).length}`);

const savedRow = perms.getPermissionOverrideRow(ROLE, REVOKED);
ok('в строке правки видно, кто и когда её сделал (ставит база)',
    !!savedRow && savedRow.changed_by === 7 && savedRow.changed_at === '2026-09-01T10:00:00Z',
    JSON.stringify(savedRow || {}));

// ВЫДАЧА: право, которого у роли не было в коде, начинает работать — и в
// интерфейсе (can), и в списке её прав. Проверяем вместе с отзывом: две правки
// в одной роли не должны мешать друг другу.
fake.tables.role_permissions = [
    { role: ROLE, permission: REVOKED, revoked: true, changed_at: '2026-09-01T10:00:00Z', changed_by: 7 },
    { role: ROLE, permission: CLOSED, granted: true, changed_at: '2026-09-02T10:00:00Z', changed_by: 7 }
];
const readGrants = await quiet(() => perms.loadPermissionOverrides());

ok('выдача из базы (granted = true) открывает право, которого в коде не было',
    readGrants.ok === true && perms.can(CLOSED) === true && perms.can(REVOKED) === false &&
    perms.can(PLAIN) === true,
    `can(${CLOSED}) = ${perms.can(CLOSED)}, can(${REVOKED}) = ${perms.can(REVOKED)}`);

ok('состояния клетки три: заводское, снятое и выданное',
    perms.getPermissionState(ROLE, PLAIN) === 'factory' &&
    perms.getPermissionState(ROLE, REVOKED) === 'revoked' &&
    perms.getPermissionState(ROLE, CLOSED) === 'granted' &&
    perms.isPermissionGranted(ROLE, CLOSED) === true &&
    perms.isPermissionRevoked(ROLE, CLOSED) === false &&
    perms.getPermissionStore().granted === 1 && perms.getPermissionStore().revoked === 1,
    `строк: ${perms.getPermissionStore().rows}, выдано: ${perms.getPermissionStore().granted}, снято: ${perms.getPermissionStore().revoked}`);

ok('hasPermission() отвечает и по чужой роли — тем же правилом, что клетки экрана',
    perms.hasPermission(ROLE, CLOSED) === true &&
    perms.hasPermission('Прораб', CLOSED) === true &&
    perms.hasPermission('Прораб', PLAIN) === false &&
    perms.getRolePermissions(ROLE).includes(CLOSED),
    `прав у Администратора: ${perms.getRolePermissions(ROLE).length}`);

// Строку «и снято, и выдано» база не принимает (ограничение таблицы), но и в
// приложении отзыв должен побеждать: иначе выдача «оживила» бы закрытое право.
fake.tables.role_permissions = [
    { role: ROLE, permission: REVOKED, revoked: true, granted: true, changed_at: '2026-09-03T10:00:00Z', changed_by: 7 }
];
await quiet(() => perms.loadPermissionOverrides());

ok('если строка противоречива, отзыв побеждает: право не работает',
    perms.can(REVOKED) === false && perms.isPermissionGranted(ROLE, REVOKED) === false,
    `can(${REVOKED}) = ${perms.can(REVOKED)}`);

fake.tables.role_permissions = [
    { role: ROLE, permission: REVOKED, revoked: true, changed_at: '2026-09-01T10:00:00Z', changed_by: 7 },
    { role: 'Уборщик', permission: PLAIN, revoked: true },       // роли нет в коде
    { role: ROLE, permission: 'no_such_right', granted: true }   // права нет в каталоге
];
const withUnknown = await quiet(() => perms.loadPermissionOverrides());

ok('строки о несуществующей роли и неизвестном праве не применяются, но названы администратору',
    withUnknown.unknown.length === 2 && perms.getPermissionStore().rows === 1 &&
    perms.can(PLAIN) === true && perms.getPermissionStore().granted === 0,
    `не понято: ${withUnknown.unknown.join(' | ') || '—'}; строк применено: ${perms.getPermissionStore().rows}`);

ok('isPermissionKnown / isPermissionLocked отвечают по закрытому списку',
    perms.isPermissionKnown('manage_access') === true &&
    perms.isPermissionKnown('no_such_right') === false &&
    perms.isPermissionLocked('manage_access') === true &&
    perms.isPermissionLocked(PLAIN) === false);

// Урезанное рабочее место роли (ROLE_UI) скрывает раздел, но выдача права в
// «🔐 Доступах» сильнее: администратор видел эту строку матрицы и поставил
// галочку, значит раздел роли нужен. Иначе галочка у «Снабженца» или
// «Финансиста» открывала бы право, которого сотрудник всё равно не видит.
fake.tables.employees = [{ id: 8, position: 'Снабженец', status: 'active', user_id: 'user-1' }];
fake.tables.role_permissions = [];
await quiet(() => perms.loadPermissions());

const snagachBefore = perms.canSeeTab('employees');

fake.tables.role_permissions = [
    { role: 'Снабженец', permission: 'view_tab_employees', granted: true, changed_at: '2026-09-04T10:00:00Z', changed_by: 7 }
];
await quiet(() => perms.loadPermissionOverrides());

ok('выдача права сильнее урезанного рабочего места: раздел и вход в него открываются',
    snagachBefore === false && perms.canSeeTab('employees') === true &&
    perms.canSeeTab('tasks') === false && perms.can('view_employees') === true,
    `до выдачи: ${snagachBefore}, после: ${perms.canSeeTab('employees')}`);

// Возвращаем состояние экрана: дальше проверяется матрица Администратора.
fake.tables.employees = [{ id: 7, position: ROLE, status: 'active', user_id: 'user-1' }];
fake.tables.role_permissions = [];
await quiet(() => perms.loadPermissions());

// ---------------------------------------------------------------------
// 3.3. Экран: матрица, черновик, сохранение
// ---------------------------------------------------------------------

/** Стоит ли галочка в клетке этого права (ищем ровно свой input). */
function hasChecked(html, arg) {
    const needle = arg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const found = html.match(new RegExp('<input type="checkbox" ([^>]*data-arg="' + needle + '"[^>]*)>'));
    return !!found && /\bchecked\b/.test(found[1]);
}

const matrix = () => elements.get('access-matrix') || elementFor('access-matrix');

fake.tables.role_permissions = [
    { role: ROLE, permission: REVOKED, revoked: true, changed_at: '2026-09-01T10:00:00Z', changed_by: 7 }
];
await quiet(() => access.loadAccess());

const screen = matrix().innerHTML;
const closedRight = catalogRights.find((right) => !perms.isPermissionDefault(ROLE, right));

ok('экран рисует матрицу «право × роль»: по таблице на группу, подписи групп — из LABELS',
    catalogGroupIds.every((id) => screen.includes(labels.ru.groups.get(id))) &&
    catalogRights.every((right) => screen.includes(labels.ru.rights.get(right))),
    `длина разметки: ${screen.length} символов`);

ok('клетки: квадратик у каждого права (пустой — права нет), 🔒 только у служебного',
    screen.includes(`data-arg="${ROLE}|${PLAIN}"`) &&
    !!closedRight && screen.includes(`data-arg="${ROLE}|${closedRight}"`) &&
    hasChecked(screen, `${ROLE}|${closedRight}`) === false &&
    !screen.includes(`data-arg="${ROLE}|manage_access"`) &&
    screen.includes('🔒') && !screen.includes('—</td>'),
    `право без галочки в коде: ${closedRight || '—'}`);

ok('снятое право показано снятой галочкой и пометкой «снято»',
    !hasChecked(screen, `${ROLE}|${REVOKED}`) && hasChecked(screen, `${ROLE}|${PLAIN}`) &&
    screen.includes(labels.ru.rights.get(REVOKED)) && screen.includes('снято'));

// Галочка → черновик → «💾 Сохранить». Проверяем всю цепочку: до сохранения в
// базу не уходит ничего, после — уходит ровно одна строка, и право гаснет.
fake.calls.length = 0;
access.toggleAccessRight({ target: { dataset: { arg: `${ROLE}|${PLAIN}` }, checked: false } });

const writes = () => fake.calls.filter((call) => call.op !== 'select');
const saveBtn = saveButton;

ok('снятие галочки — это черновик: «Сохранить» показывает число правок, в базу ничего не ушло',
    saveBtn().textContent.includes('(1)') && writes().length === 0,
    `кнопка: «${saveBtn().textContent}», записей в базу: ${writes().length}`);

createdNodes.length = 0;
await quiet(() => access.saveAccessMatrix());

const insert = fake.calls.find((call) => call.op === 'insert');
ok('«💾 Сохранить» добавляет строку в public.role_permissions (новой пары в базе не было)',
    !!insert && insert.table === 'role_permissions' && insert.payload.role === ROLE &&
    insert.payload.permission === PLAIN && insert.payload.revoked === true,
    JSON.stringify(insert ? insert.payload : {}));

ok('запись уходит без changed_at и changed_by — их ставит триггер базы, а не клиент',
    !!insert && !('changed_at' in insert.payload) && !('changed_by' in insert.payload),
    `поля запроса: ${insert ? Object.keys(insert.payload).join(', ') : '—'}`);

ok('после сохранения право сразу не работает, а галочка на экране снята',
    perms.can(PLAIN) === false && !hasChecked(matrix().innerHTML, `${ROLE}|${PLAIN}`),
    `can(${PLAIN}) = ${perms.can(PLAIN)}`);

ok('администратор видит подтверждение с числом сохранённых правок',
    createdNodes.some((node) => node.innerHTML.includes('Права сохранены: 1')),
    createdNodes.map((node) => node.innerHTML).join(' | ') || 'сообщения нет');

// Возврат права: строка в базе НЕ удаляется (история изменений), а получает
// revoked = false — так видно, что право когда-то снимали.
fake.calls.length = 0;
access.toggleAccessRight({ target: { dataset: { arg: `${ROLE}|${PLAIN}` }, checked: true } });
await quiet(() => access.saveAccessMatrix());

const update = fake.calls.find((call) => call.op === 'update');
ok('возврат права — это update строки (revoked = false, granted = false), а не удаление: история остаётся',
    !!update && update.table === 'role_permissions' && update.payload.revoked === false &&
    update.payload.granted === false &&
    update.filters.role === ROLE && update.filters.permission === PLAIN &&
    !fake.calls.some((call) => call.op === 'delete') && perms.can(PLAIN) === true,
    JSON.stringify(update ? { payload: update.payload, filters: update.filters } : {}));

// Галочка в ПУСТОМ квадратике — это ВЫДАЧА права: в базу уходит строка с
// granted = true, а право начинает работать сразу после сохранения — и в
// приложении, и в базе (там его проверяет public.rsk_permission_granted()).
fake.calls.length = 0;
fake.tables.role_permissions = fake.tables.role_permissions.filter((row) => row.permission !== CLOSED);
createdNodes.length = 0;
access.toggleAccessRight({ target: { dataset: { arg: `${ROLE}|${CLOSED}` }, checked: true } });

const grantDraft = saveBtn().textContent;
await quiet(() => access.saveAccessMatrix());

const grantInsert = fake.calls.find((call) => call.op === 'insert');
ok('галочка в пустой клетке — выдача: в базу идёт granted = true, revoked = false',
    !!grantInsert && grantInsert.table === 'role_permissions' &&
    grantInsert.payload.role === ROLE && grantInsert.payload.permission === CLOSED &&
    grantInsert.payload.granted === true && grantInsert.payload.revoked === false &&
    !('changed_at' in grantInsert.payload) && !('changed_by' in grantInsert.payload) &&
    grantDraft.includes('(1)'),
    JSON.stringify(grantInsert ? grantInsert.payload : {}));

ok('после сохранения право у роли работает, клетка — с галочкой и пометкой «выдано»',
    perms.can(CLOSED) === true && perms.getPermissionState(ROLE, CLOSED) === 'granted' &&
    hasChecked(matrix().innerHTML, `${ROLE}|${CLOSED}`) &&
    matrix().innerHTML.includes('выдано') &&
    (elements.get('access-summary') || elementFor('access-summary')).innerHTML.includes('Выдано: 1'),
    `can(${CLOSED}) = ${perms.can(CLOSED)}`);

// «↩» у роли возвращает заводские права в ОБЕ стороны: и снятое (add_employee),
// и выданное (close_section) — двумя строками-правками, без удаления из базы.
fake.calls.length = 0;
access.resetRoleAccess(ROLE);

const resetDraft = fake.calls.length === 0;
await quiet(() => access.saveAccessMatrix());

const resets = fake.calls.filter((call) => call.op === 'update');
ok('«↩» у роли возвращает заводское и для выдачи, и для отзыва (без удаления строк)',
    resets.length === 2 &&
    resets.every((call) => call.payload.revoked === false && call.payload.granted === false) &&
    resets.map((call) => call.filters.permission).sort().join(',') === [REVOKED, CLOSED].sort().join(',') &&
    perms.can(PLAIN) === true && perms.can(REVOKED) === true && perms.can(CLOSED) === false &&
    resetDraft && !fake.calls.some((call) => call.op === 'delete'),
    `правок: ${resets.length} (${resets.map((call) => call.filters.permission).join(', ')}), can(${CLOSED}) = ${perms.can(CLOSED)}`);

ok('экран доступен разметке: обработчики на window.* (data-action зовут их по имени)',
    ['loadAccess', 'toggleAccessRight', 'resetRoleAccess', 'revertAccessDraft', 'saveAccessMatrix']
        .every((name) => typeof globalThis.window[name] === 'function'),
    Object.keys(globalThis.window).filter((name) => /Access/.test(name)).join(', '));

// «↩ Отменить»: черновик выбрасывается, база не трогается.
fake.calls.length = 0;
access.toggleAccessRight({ target: { dataset: { arg: `${ROLE}|${PLAIN}` }, checked: false } });
access.revertAccessDraft();

ok('«↩ Отменить» выбрасывает черновик и не пишет в базу',
    saveBtn().disabled === true && writes().length === 0 && perms.can(PLAIN) === true,
    `кнопка выключена: ${saveBtn().disabled}`);

// Служебное право и незнакомые значения отклоняются ДО базы — и при выдаче, и
// при отзыве: админ не может ни выключить себе вход сюда, ни записать мусор.
fake.calls.length = 0;
const rejected = await quiet(() => perms.savePermissionOverrides([
    { role: ROLE, permission: 'manage_access', allowed: false },
    { role: ROLE, permission: 'manage_access', allowed: true },
    { role: ROLE, permission: 'no_such_right', allowed: true },
    { role: 'Уборщик', permission: PLAIN, allowed: true }
]));

ok('служебное право не меняется, неизвестные право и роль отклоняются без записей в базу',
    rejected.ok === false && rejected.saved === 0 &&
    ['locked', 'unknown_permission', 'unknown_role'].every((reason) =>
        rejected.failed.some((item) => item.reason === reason)) &&
    fake.calls.length === 0,
    `причины: ${rejected.failed.map((item) => item.reason).join(', ') || '—'}; записей: ${fake.calls.length}`);

// ---------------------------------------------------------------------
// 3.4. Закрытый раздел не открывается при входе
// ---------------------------------------------------------------------
fake.tables.employees = [{ id: 8, position: 'Снабженец', status: 'active', user_id: 'user-1' }];
fake.tables.role_permissions = [];
await quiet(() => perms.loadPermissions());

ok('без отзывов роль попадает на свой рабочий экран после входа',
    perms.getRole() === 'Снабженец' && perms.getStartTab() === 'orders' && perms.canSeeTab('orders') === true,
    `роль: ${perms.getRole()}, раздел входа: ${perms.getStartTab() || '—'}`);

fake.tables.role_permissions = [{ role: 'Снабженец', permission: 'view_orders_tab', revoked: true }];
await quiet(() => perms.loadPermissions());

ok('раздел, закрытый администратором, не открывается при входе (getStartTab = null)',
    perms.can('view_orders_tab') === false && perms.canSeeTab('orders') === false &&
    perms.getStartTab() === null,
    `getStartTab() = ${perms.getStartTab() || 'null'}, canSeeTab('orders') = ${perms.canSeeTab('orders')}`);

// =====================================================================
// ИТОГ И ОТЧЁТ
// =====================================================================
log('');
log(failed === 0
    ? '  ВСЁ ВЕРНО: подписи, каталог, снятие и выдача прав в разделе «🔐 Доступы» работают'
    : '  не прошло проверок: ' + failed);

const outDir = path.join(os.tmpdir(), 'freedom-fin');
try {
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'access-check.txt'), report.join('\r\n'), 'utf8');
} catch { /* нет доступа к %TEMP% — отчёт остаётся в консоли */ }

process.exit(failed === 0 ? 0 : 1);


