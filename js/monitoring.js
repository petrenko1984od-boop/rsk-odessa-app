// =====================================================================
// МОДУЛЬ: ЖУРНАЛ ОШИБОК (эксплуатация — «что падает у сотрудников»)
// =====================================================================
// ЗАЧЕМ. Об ошибке узнавали со слов: «у меня не сохраняется». В консоли
// браузера лежит готовый ответ — текст и стек, — но сотрудник не обязан уметь
// открывать DevTools, а просьба «пришлите скриншот консоли» не выполняется.
// Поэтому приложение само складывает ошибки в базу (таблица public.app_errors,
// database/migrate-v2.9-ops-monitoring.sql), откуда их видно запросом —
// готовые запросы в ops/README.md («Журнал ошибок»).
//
// ЧТО ЛОВИТСЯ:
//   * error              — необработанное исключение (в т.ч. внутри действия
//                          интерфейса: js/actions.js зовёт обработчик напрямую,
//                          поэтому исключение доходит сюда);
//   * rejection          — промис без обработчика (обычно забытый await);
//   * reportProblem(...) — явные сообщения модулей: там, где отказ уже пойман
//                          и показан тостом, но причину надо сохранить
//                          (доступно как window.reportProblem).
//
// ЧЕГО ЗДЕСЬ НЕТ (сознательно):
//   * внешнего сервиса (Sentry и подобных): он требует правки политики CSP
//     connect-src, отдельного домена и учётной записи — а ошибки всё равно
//     уезжают наружу. Своя таблица работает в рамках уже разрешённых адресов
//     и закрыта RLS (читают Администратор и Директор);
//   * данных приложения: пишутся только текст ошибки, стек, адрес страницы,
//     версия и ревизия оболочки. Ни сумм, ни файлов, ни паролей модуль не
//     передаёт — их у него и нет (см. набор полей команды в миграции).
//
// КАК ОТПРАВЛЯЕТ. Записи копятся в localStorage (перезагрузка и закрытие
// вкладки их не теряют) и уходят ПАЧКОЙ: сразу при появлении, при возврате
// связи, при уходе вкладки в фон и по таймеру. Офлайн ошибки остаются в
// буфере до следующего сеанса — именно ради этого буфер и нужен.
//
// ⚠️ На локальном сервере журнал ВЫКЛЮЧЕН: там приложение гоняют проверочные
//    прогоны с моком базы, и их «ошибки» — часть сценариев, а не проблемы
//    сотрудников. Включить для отладки: адрес с ?rsk-monitoring.
//
// Отключить у конкретного сотрудника, если что-то мешает: очистить
// localStorage (ключ rsk-app-errors). Сама отправка работе не мешает: ошибки
// отправки глушатся и только пишутся в консоль.
// =====================================================================

import { CONFIG } from './config.js';
import { rpc } from './database.js';
import { log } from './utils.js';

// ---------------------------------------------------------------- НАСТРОЙКИ

const STORAGE_KEY = 'rsk-app-errors';   // буфер в localStorage
const BATCH_SIZE = 20;                  // столько принимает команда базы за раз
const MAX_BUFFER = 60;                  // больше не копим: старое уже не нужно
const FLUSH_DELAY_MS = 5000;            // подождать: ошибки часто идут пачкой
const MAX_MESSAGE = 500;
const MAX_STACK = 2000;
const SEEN_LIMIT = 40;                  // «одно и то же за сеанс» — один раз

let started = false;
let sending = false;
let timer = null;
const seen = [];

// --------------------------------------------- ГДЕ ЖУРНАЛ НЕ РАБОТАЕТ

/**
 * Локальный запуск (localhost / 127.0.0.1 / файл) — это прогоны проверок и
 * разработка: их ошибки в боевую базу не пишем. Флаг ?rsk-monitoring включает
 * журнал на локальном адресе вручную — так его можно проверить.
 */
function disabledHere() {
    const host = String(location.hostname || '');
    const local = !host || host === 'localhost' || host === '127.0.0.1'
        || host === '::1' || location.protocol === 'file:';
    const forced = new URLSearchParams(location.search).has('rsk-monitoring');
    return local && !forced;
}

// ------------------------------------------------------- БУФЕР (localStorage)

function readBuffer() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        const list = raw ? JSON.parse(raw) : [];
        return Array.isArray(list) ? list : [];
    } catch {
        return [];   // приватный режим или выключенное хранилище — пишем без буфера
    }
}

function writeBuffer(list) {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(list.slice(-MAX_BUFFER)));
    } catch { /* нет места или доступа — запись об ошибке не стоит того, чтобы мешать работе */ }
}

/**
 * Ревизия оболочки (r1, r2, …) для журнала: она живёт в sw.js и в имени кэша,
 * поэтому берём её из кэша, а не дублируем в CONFIG (дубликат разошёлся бы).
 */
async function shellRevision() {
    try {
        if (typeof caches === 'undefined') return '';
        const keys = await caches.keys();
        const mine = keys.find((key) => key.startsWith(`rsk-odessa-v${CONFIG.APP.VERSION}-`));
        return mine ? mine.slice(mine.lastIndexOf('-') + 1) : '';
    } catch {
        return '';
    }
}

/** Собирает запись журнала: ровно те поля, что принимает команда базы. */
function entryOf(kind, message, extra = {}, revision = '') {
    return {
        app_version: CONFIG.APP.VERSION,
        shell_revision: revision,
        kind: String(kind || 'error').slice(0, 24),
        message: String(message || '(без текста)').slice(0, MAX_MESSAGE),
        stack: String(extra.stack || '').slice(0, MAX_STACK),
        page: String(location.pathname || '').slice(0, 200),
        user_agent: String(navigator.userAgent || '').slice(0, 300),
        context: extra.context && typeof extra.context === 'object' ? extra.context : {}
    };
}

// -------------------------------------------------------------- ЗАПИСЬ

/**
 * Сообщить о проблеме вручную (доступно как window.reportProblem).
 *
 * Нужно там, где отказ уже пойман и показан сотруднику, но причину стоит
 * сохранить: например, сохранение счёта вернуло ошибку базы. Вызов ничего не
 * возвращает и никогда не бросает исключение.
 *
 * @param {string} kind — 'save' | 'network' | 'action' | 'sw' | 'error'
 * @param {string} message — короткий текст ошибки (уйдёт в журнал)
 * @param {{ stack?: string, context?: object }} [extra]
 */
export function reportProblem(kind, message, extra = {}) {
    if (!started) return;
    remember(kind, message);
    push(entryOf(kind, message, extra));
    scheduleFlush();
}

/** Одинаковые сообщения в одном сеансе — один раз: иначе журнал забьёт одна и та же ошибка. */
function remember(kind, message) {
    const mark = `${kind}|${String(message).slice(0, 200)}`;
    if (seen.includes(mark)) return false;
    seen.push(mark);
    if (seen.length > SEEN_LIMIT) seen.shift();
    return true;
}

function push(entry) {
    const list = readBuffer();
    list.push(entry);
    writeBuffer(list);
}

function scheduleFlush() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; flush(); }, FLUSH_DELAY_MS);
}

// -------------------------------------------------------------- ОТПРАВКА

async function flush() {
    if (sending || !started) return;

    const list = readBuffer();
    if (!list.length) return;

    // Офлайна боятся не ошибки, а их потеря: буфер подождёт связи.
    if (!navigator.onLine) return;

    sending = true;
    const batch = list.slice(0, BATCH_SIZE);

    try {
        const { error } = await rpc('rsk_log_app_errors', { entries: batch });

        if (error) {
            // База не обновлена (нет миграции) или нет прав — пишем в консоль
            // один раз на попытку, но буфер НЕ чистим: иначе ошибки сотрудников
            // исчезнут вместе с неудачной отправкой.
            log.warn('Журнал ошибок: база отклонила запись —', error.message || error);
            return;
        }

        writeBuffer(readBuffer().slice(batch.length));
        log.info(`Журнал ошибок: отправлено записей — ${batch.length}`);

        if (readBuffer().length >= BATCH_SIZE) scheduleFlush();
    } catch (error) {
        log.warn('Журнал ошибок: отправить не удалось', error);
    } finally {
        sending = false;
    }
}

// ---------------------------------------------------------------- ЗАПУСК

/** Подключает журнал к приложению (вызывается один раз при загрузке — js/main.js). */
export function initMonitoring() {
    if (started || disabledHere()) return;
    started = true;

    window.addEventListener('error', (event) => {
        // Ошибки загрузки картинок тоже приходят событием 'error', но у них нет
        // ни текста, ни объекта ошибки — заполнять журнал нечем.
        if (!event.error && !event.message) return;

        const message = event.message || String((event.error && event.error.message) || 'Неизвестная ошибка');
        if (!remember('error', message)) return;

        push(entryOf('error', message, {
            stack: (event.error && event.error.stack) || '',
            context: { source: `${event.filename || ''}:${event.lineno || 0}:${event.colno || 0}` }
        }));

        // Ревизия оболочки читается из кэша (caches.keys()) — это асинхронно,
        // поэтому подставляем её уже после того, как запись легла в буфер.
        shellRevision().then((revision) => {
            if (!revision) { scheduleFlush(); return; }
            const list = readBuffer();
            for (const item of list) item.shell_revision = item.shell_revision || revision;
            writeBuffer(list);
            scheduleFlush();
        });
    });

    window.addEventListener('unhandledrejection', (event) => {
        const reason = event.reason;
        const message = (reason && (reason.message || reason.error_description || String(reason)))
            || 'Промис завершился ошибкой без причины';
        if (!remember('rejection', message)) return;

        push(entryOf('rejection', message, { stack: (reason && reason.stack) || '', context: {} }));
        scheduleFlush();
    });

    // Связь вернулась — самое время отдать накопившееся.
    window.addEventListener('online', () => flush());

    // Вкладка ушла в фон: на телефоне её могут закрыть, и буфер «застрянет» до
    // следующего сеанса. Отправка короткая, поэтому успевает.
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') flush();
    });

    window.reportProblem = reportProblem;
    if (readBuffer().length) scheduleFlush();

    log.info(`Журнал ошибок подключён (v${CONFIG.APP.VERSION}); в буфере записей: ${readBuffer().length}`);
}
