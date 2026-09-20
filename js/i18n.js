// =====================================================================
// RSK ODESSA — ЯЗЫКИ (RU / UK)
// =====================================================================
// У приложения две версии интерфейса: русская (по умолчанию) и украинская.
// Переключатель — в «Настройках» (⚙ в меню «Кабинет»), выбор хранится в
// localStorage устройства: каждый сотрудник ставит свой язык сам.
//
// Как это работает:
//   1. t('ключ') — для новых модулей: строка берётся из словаря ниже;
//   2. data-i18n="ключ" в разметке — для статичных надписей index.html;
//   3. фразовый словарь PHRASES — для старых модулей, где строки написаны
//      прямо в коде (js/modules/*.js). Он переводит уже готовый DOM:
//      MutationObserver ловит новые элементы и заменяет русские фразы.
//      Нет фразы в словаре — текст остаётся русским, ничего не ломается.
//      Дописать перевод = добавить пару в PHRASES (см. README).
//
// Модуль ничего не импортирует: его подключают и utils.js, и main.js.
// =====================================================================

export const LANGUAGES = [
    { code: 'ru', label: '🇷🇺 Русский' },
    { code: 'uk', label: '🇺🇦 Українська' }
];

export const DEFAULT_LANG = 'ru';

const STORAGE_KEY = 'rsk.lang';

let currentLang = DEFAULT_LANG;
let observers = [];

// =====================================================================
// СЛОВАРЬ (ключ → перевод)
// =====================================================================

const DICT = {
    ru: {
        // --- общее ---
        'common.close': 'Закрыть',
        'common.cancel': 'Отмена',
        'common.save': '💾 Сохранить',
        'common.loading': 'Загрузка...',
        'common.export': '📥 Excel',
        'common.open': 'Открыть',
        'common.refresh': '🔄 Обновить',
        'common.all': 'Все',
        'common.none': 'Нет данных',
        'common.sum': 'Сумма',
        'common.date': 'Дата',
        'common.comment': 'Комментарий',
        'common.object': 'Объект',
        'common.section': 'Раздел',
        'common.total': 'Итого',

        // --- настройки ---
        'settings.title': '⚙ Настройки приложения',
        'settings.subtitle': 'Язык интерфейса и цветовая схема. Настройки сохраняются для этого устройства.',
        'settings.language': 'Язык интерфейса',
        'settings.theme': 'Цветовая схема',
        'settings.themeHint': 'Каждый сотрудник выбирает оформление сам — на других это не влияет.',
        'settings.saved': 'Настройки сохранены',
        'settings.version': 'Версия приложения',

        // --- ведомость пополнений подотчёта финансиста ---
        'statement.button': '📄 Ведомость пополнений',
        'statement.buttonFinancier': '📄 Ведомость пополнений от директора',
        'statement.title': '📄 Ведомость пополнений подотчёта финансиста',
        'statement.subtitle': 'Кто, когда и сколько передал денег в подотчёт финансиста.',
        'statement.empty': 'Пополнений пока не было',
        'statement.counterparty': 'Передал',
        'statement.total': 'Всего пополнено',
        'statement.count': 'Пополнений',
        'statement.fileName': 'Vedomost_popolneniy',
        'statement.sheet': 'Пополнения подотчёта',

        // --- счета на материалы (стол финансиста) ---
        'invoice.panelTitle': '🧾 Счета на материалы',
        'invoice.panelSubtitle': 'Счета от снабжения: материалы уже на объекте, деньги ещё не перечислены.',
        'invoice.empty': 'Счетов к оплате нет',
        'invoice.pay': '✅ Оплачено',
        'invoice.openFile': '🧾 Открыть счёт',
        'invoice.noFile': 'файл счёта не загружен',
        'invoice.of': 'Счёт',
        'invoice.delivered': 'доставлено',
        'invoice.notDelivered': 'в обработке',
        'invoice.confirm': 'Отметить счёт по заявке {number} как оплаченный?\n\nДеньги уходят с расчётного счёта фирмы — подотчёт финансиста не меняется.',
        'invoice.paidToast': 'Счёт {number} отмечен оплаченным',
        'invoice.paidBy': 'Оплатил',
        'invoice.paidAt': 'Оплачено',
        'invoice.noPermission': 'Нет прав на оплату счетов',

        // меню блока «Счета на материалы» и выгрузка в Excel по фильтру
        'invoice.tabOpen': '⏳ Ожидают оплату',
        'invoice.tabPaid': '✅ Оплаченные',
        'invoice.emptyPaid': 'Оплаченных счетов пока нет',
        'invoice.emptyPaidPeriod': 'За выбранный период оплаченных счетов нет',
        'invoice.periodAll': '📅 Всё время',
        'invoice.periodMonth': '📅 Этот месяц',
        'invoice.periodPrev': '📅 Прошлый месяц',
        'invoice.periodHint': 'Фильтр по дате оплаты: сужает и список на экране, и выгрузку в Excel',
        'invoice.export': '📥 Excel',
        'invoice.exportHint': 'Скачать в Excel то, что видно на экране (с учётом фильтра)',
        'invoice.exportEmpty': 'В этом списке нет счетов для выгрузки',
        'invoice.exported': 'Выгружено счетов: {count}',
        'invoice.noXlsx': 'Библиотека XLSX не загружена',
        'invoice.colNumber': '№ заявки',
        'invoice.colSupplier': 'Поставщик',
        'invoice.colSum': 'Сумма по счёту',
        'invoice.sheetOpen': 'Счета к оплате',
        'invoice.sheetPaid': 'Оплаченные счета',
        'invoice.fileOpen': 'Scheta_k_oplate',
        'invoice.filePaid': 'Oplachennye_scheta',

        // --- рабочий стол финансиста: один блок «Финансовые заявки» ---
        'finDesktop.deskTitle': '💰 Финансовые заявки',
        'finDesktop.deskSubtitle': 'Счета поставщиков и заявки на выдачу — в одном блоке',
        'finDesktop.sectionSubtitle': 'Один блок «Финансовые заявки»: 🧾 счета на материалы и 🟡 заявки на выдачу.',
        'finDesktop.approvedTitle': '🟡 Одобренные заявки на выдачу',
        'finDesktop.approvedSubtitle': 'Директор одобрил — деньги нужно выдать из вашего подотчёта.',
        'finDesktop.tabApproved': '🟡 К выдаче',
        'finDesktop.tabIssued': '🟢 Выданные',
        'finDesktop.emptyApproved': 'Одобренных заявок нет',
        'finDesktop.emptyApprovedHint': 'Все одобренные заявки уже оплачены. Новая появится здесь, как только директор её одобрит.',
        'finDesktop.emptyIssued': 'Выданных заявок пока нет',
        'finDesktop.emptyIssuedHint': 'Здесь будет история: заявки, по которым вы уже выдали деньги.',

        // --- счёт поставщика (снабженец) ---
        'order.invoiceButton': '🧾 Счёт от поставщика',
        'order.invoiceTitle': '🧾 Счёт поставщика по заявке',
        'order.invoiceHint': 'Загрузите фото или скан счёта и заполните цены по позициям. После сохранения счёт появится на рабочем столе финансиста в блоке «Счета на материалы», а заявка перейдёт в «Ожидает оплаты».',
        'order.invoiceFile': 'Файл счёта (фото, скрин, PDF)',
        'order.invoiceFileCurrent': 'Текущий файл счёта',
        'order.invoiceSupplier': 'Поставщик / магазин / база',
        'order.invoicePrices': '💰 Цены по позициям (по счёту)',
        'order.invoiceTotal': 'Итого по счёту',
        'order.invoiceSaved': 'Счёт по заявке {number} сохранён',
        'order.invoiceUploadFailed': 'Не удалось загрузить файл счёта',
        'order.invoiceNeedSupplier': 'Укажи поставщика',
        'order.invoiceNeedPrices': 'Укажи цену для позиции «{name}»',
        'order.deliveredButton': '🚚 Доставлено на объект',
        'order.deliveredTitle': '🚚 Доставлено на объект',
        'order.deliveredInfo': 'Закрывая закупку, вы подтверждаете, что материалы приехали на объект. Позиции сразу попадут в «Реестр материалов» — независимо от того, оплачен счёт или нет.',
        'order.deliveredToast': 'Заявка {number} доставлена на объект',
        'order.takeToWork': '▶ Взять в работу',
        'order.toArchive': '📥 В архив',
        'order.paymentPending': '⏳ Ожидает оплаты (счёт у финансиста)',
        'order.paymentPaid': '✅ Оплачено',
        'order.paymentCompany': '🏢 Фирма (по счёту / безнал)',
        'order.paymentEmployee': '💵 Снабженец (наличными из подотчёта)'
    },

    uk: {
        // --- загальне ---
        'common.close': 'Закрити',
        'common.cancel': 'Скасувати',
        'common.save': '💾 Зберегти',
        'common.loading': 'Завантаження...',
        'common.export': '📥 Excel',
        'common.open': 'Відкрити',
        'common.refresh': '🔄 Оновити',
        'common.all': 'Усі',
        'common.none': 'Немає даних',
        'common.sum': 'Сума',
        'common.date': 'Дата',
        'common.comment': 'Коментар',
        'common.object': 'Обʼєкт',
        'common.section': 'Розділ',
        'common.total': 'Разом',

        // --- налаштування ---
        'settings.title': '⚙ Налаштування застосунку',
        'settings.subtitle': 'Мова інтерфейсу та колірна схема. Налаштування зберігаються для цього пристрою.',
        'settings.language': 'Мова інтерфейсу',
        'settings.theme': 'Колірна схема',
        'settings.themeHint': 'Кожен співробітник обирає оформлення сам — на інших це не впливає.',
        'settings.saved': 'Налаштування збережено',
        'settings.version': 'Версія застосунку',

        // --- відомість поповнень підзвіту фінансиста ---
        'statement.button': '📄 Відомість поповнень',
        'statement.buttonFinancier': '📄 Відомість поповнень від директора',
        'statement.title': '📄 Відомість поповнень підзвіту фінансиста',
        'statement.subtitle': 'Хто, коли і скільки передав грошей у підзвіт фінансиста.',
        'statement.empty': 'Поповнень ще не було',
        'statement.counterparty': 'Передав',
        'statement.total': 'Усього поповнено',
        'statement.count': 'Поповнень',
        'statement.fileName': 'Vidomist_popovnen',
        'statement.sheet': 'Поповнення підзвіту',

        // --- рахунки на матеріали ---
        'invoice.panelTitle': '🧾 Рахунки на матеріали',
        'invoice.panelSubtitle': 'Рахунки від постачання: матеріали вже на обʼєкті, гроші ще не переказані.',
        'invoice.empty': 'Рахунків до оплати немає',
        'invoice.pay': '✅ Сплачено',
        'invoice.openFile': '🧾 Відкрити рахунок',
        'invoice.noFile': 'файл рахунку не завантажено',
        'invoice.of': 'Рахунок',
        'invoice.delivered': 'доставлено',
        'invoice.notDelivered': 'в обробці',
        'invoice.confirm': 'Позначити рахунок за заявкою {number} як сплачений?\n\nГроші йдуть з розрахункового рахунку фірми — підзвіт фінансиста не змінюється.',
        'invoice.paidToast': 'Рахунок {number} позначено сплаченим',
        'invoice.paidBy': 'Сплатив',
        'invoice.paidAt': 'Сплачено',
        'invoice.noPermission': 'Немає прав на оплату рахунків',

        // меню блоку «Рахунки на матеріали» та вивантаження в Excel за фільтром
        'invoice.tabOpen': '⏳ Очікують оплати',
        'invoice.tabPaid': '✅ Сплачені',
        'invoice.emptyPaid': 'Сплачених рахунків поки немає',
        'invoice.emptyPaidPeriod': 'За обраний період сплачених рахунків немає',
        'invoice.periodAll': '📅 Увесь час',
        'invoice.periodMonth': '📅 Цей місяць',
        'invoice.periodPrev': '📅 Минулий місяць',
        'invoice.periodHint': 'Фільтр за датою сплати: звужує і список на екрані, і вивантаження в Excel',
        'invoice.export': '📥 Excel',
        'invoice.exportHint': 'Завантажити в Excel те, що видно на екрані (з урахуванням фільтра)',
        'invoice.exportEmpty': 'У цьому списку немає рахунків для вивантаження',
        'invoice.exported': 'Вивантажено рахунків: {count}',
        'invoice.noXlsx': 'Бібліотека XLSX не завантажена',
        'invoice.colNumber': '№ заявки',
        'invoice.colSupplier': 'Постачальник',
        'invoice.colSum': 'Сума за рахунком',
        'invoice.sheetOpen': 'Рахунки до оплати',
        'invoice.sheetPaid': 'Сплачені рахунки',
        'invoice.fileOpen': 'Rahunky_do_oplaty',
        'invoice.filePaid': 'Splacheni_rahunky',

        // --- робочий стіл фінансиста: один блок «Фінансові заявки» ---
        'finDesktop.deskTitle': '💰 Фінансові заявки',
        'finDesktop.deskSubtitle': 'Рахунки постачальників і заявки на видачу — в одному блоці',
        'finDesktop.sectionSubtitle': 'Один блок «Фінансові заявки»: 🧾 рахунки на матеріали та 🟡 заявки на видачу.',
        'finDesktop.approvedTitle': '🟡 Схвалені заявки на видачу',
        'finDesktop.approvedSubtitle': 'Директор схвалив — гроші потрібно видати з вашого підзвіту.',
        'finDesktop.tabApproved': '🟡 До видачі',
        'finDesktop.tabIssued': '🟢 Видані',
        'finDesktop.emptyApproved': 'Схвалених заявок немає',
        'finDesktop.emptyApprovedHint': 'Усі схвалені заявки вже оплачені. Нова з’явиться тут, щойно директор її схвалить.',
        'finDesktop.emptyIssued': 'Виданих заявок поки немає',
        'finDesktop.emptyIssuedHint': 'Тут буде історія: заявки, за якими ви вже видали гроші.',

        // --- рахунок постачальника ---
        'order.invoiceButton': '🧾 Рахунок від постачальника',
        'order.invoiceTitle': '🧾 Рахунок постачальника за заявкою',
        'order.invoiceHint': 'Завантажте фото або скан рахунку та заповніть ціни за позиціями. Після збереження рахунок зʼявиться на робочому столі фінансиста в блоці «Рахунки на матеріали», а заявка перейде в «Очікує оплати».',
        'order.invoiceFile': 'Файл рахунку (фото, скрин, PDF)',
        'order.invoiceFileCurrent': 'Поточний файл рахунку',
        'order.invoiceSupplier': 'Постачальник / магазин / база',
        'order.invoicePrices': '💰 Ціни за позиціями (за рахунком)',
        'order.invoiceTotal': 'Разом за рахунком',
        'order.invoiceSaved': 'Рахунок за заявкою {number} збережено',
        'order.invoiceUploadFailed': 'Не вдалося завантажити файл рахунку',
        'order.invoiceNeedSupplier': 'Вкажіть постачальника',
        'order.invoiceNeedPrices': 'Вкажіть ціну для позиції «{name}»',
        'order.deliveredButton': '🚚 Доставлено на обʼєкт',
        'order.deliveredTitle': '🚚 Доставлено на обʼєкт',
        'order.deliveredInfo': 'Закриваючи закупівлю, ви підтверджуєте, що матеріали прибули на обʼєкт. Позиції одразу потраплять до «Реєстру матеріалів» — незалежно від того, сплачено рахунок чи ні.',
        'order.deliveredToast': 'Заявку {number} доставлено на обʼєкт',
        'order.takeToWork': '▶ Взяти в роботу',
        'order.toArchive': '📥 До архіву',
        'order.paymentPending': '⏳ Очікує оплати (рахунок у фінансиста)',
        'order.paymentPaid': '✅ Сплачено',
        'order.paymentCompany': '🏢 Фірма (за рахунком / безготівково)',
        'order.paymentEmployee': '💵 Постачальник (готівкою з підзвіту)'
    }
};

// =====================================================================
// ФРАЗОВЫЙ СЛОВАРЬ ДЛЯ СТАРЫХ МОДУЛЕЙ (ru → uk)
// =====================================================================
// Строки в js/modules/*.js написаны прямо в коде, и переписывать их все на
// t() не нужно: перевод подставляется в готовый DOM по этой таблице.
// Замена идёт от длинных фраз к коротким, поэтому «Мои заявки на
// финансирование» переведётся раньше, чем «Мои заявки».
// Добавили новую надпись в интерфейсе — допишите пару сюда.

const PHRASES = [
    // --- шапка и разделы ---
    ['Управление строительством', 'Управління будівництвом'],
    ['Рабочий стол финансиста', 'Робочий стіл фінансиста'],
    ['Рабочий экран', 'Робочий екран'],
    ['Рабочий стол', 'Робочий стіл'],
    ['Финансовые запросы', 'Фінансові запити'],
    ['Заказ материалов', 'Замовлення матеріалів'],
    ['Авансовый отчёт', 'Авансовий звіт'],
    ['Мои заявки на финансирование', 'Мої заявки на фінансування'],
    ['Мои заявки на материалы', 'Мої заявки на матеріали'],
    ['Мои заявки', 'Мої заявки'],
    ['Мои задачи', 'Мої завдання'],
    ['Объекты', "Об'єкти"],
    ['Сотрудники', 'Співробітники'],
    ['Снабжение', 'Постачання'],
    ['Финансы', 'Фінанси'],
    ['Реестр', 'Реєстр'],
    ['Кабинет', 'Кабінет'],
    ['Выйти', 'Вийти'],

    // --- статусы заявок и оплат ---
    ['Доставлено на объект', "Доставлено на об'єкт"],
    ['Ожидает оплаты', 'Очікує оплати'],
    ['На доработке', 'На доопрацюванні'],
    ['В обработке', 'В обробці'],
    ['Одобренные', 'Схвалені'],
    ['Отклонённые', 'Відхилені'],
    ['Активные', 'Активні'],
    ['Ожидает', 'Очікує'],
    ['Одобрено', 'Схвалено'],
    ['Отклонено', 'Відхилено'],
    ['Выданные', 'Видані'],
    ['Выдано', 'Видано'],
    ['Закрытые', 'Закриті'],
    ['Закрыта', 'Закрита'],
    ['Новые', 'Нові'],
    ['Новая', 'Нова'],
    ['Оплачено', 'Сплачено'],
    ['Архив', 'Архів'],

    // --- кнопки и действия ---
    ['Добавить сотрудника', 'Додати співробітника'],
    ['Добавить объект', "Додати об'єкт"],
    ['Удалить объект', "Видалити об'єкт"],
    ['Создать заявку', 'Створити заявку'],
    ['Создать задачу', 'Створити завдання'],
    // Кнопка сворачивания блока на рабочем экране прораба
    // (js/modules/dashboard.js → toggleDashboardBlock)
    ['Скрыть', 'Сховати'],
    ['Показать', 'Показати'],
    ['Заказать материалы', 'Замовити матеріали'],
    ['Назад к списку объектов', "Назад до списку об'єктів"],
    ['Сохраняем...', 'Зберігаємо...'],
    ['Загрузка...', 'Завантаження...'],
    ['Отмена', 'Скасувати'],
    ['Удалить', 'Видалити'],

    // --- подвкладки карточки объекта ---
    ['Общая информация', 'Загальна інформація'],
    ['Доп. расходы', 'Дод. витрати'],
    ['Смета объекта', "Кошторис об'єкта"],
    ['План-факт', 'План-факт'],
    ['График', 'Графік'],
    ['Файлы', 'Файли'],

    // --- таблицы, фильтры, списки ---
    ['Заявок нет', 'Заявок немає'],
    ['Нет позиций', 'Немає позицій'],
    ['Все объекты', "Усі об'єкти"],
    ['Все разделы', 'Усі розділи'],
    ['Все категории', 'Усі категорії'],
    ['Все сотрудники', 'Усі співробітники'],
    ['Все оплаты', 'Усі оплати'],
    ['Сотрудник', 'Співробітник'],
    ['Создал', 'Створив'],
    ['Раздел', 'Розділ'],
    ['Итого', 'Разом'],
    ['Сброс', 'Скидання'],
    ['Поиск', 'Пошук'],

    // --- сообщения ---
    ['Нет прав на удаление', 'Немає прав на видалення'],
    ['Не удалось загрузить заявки', 'Не вдалося завантажити заявки'],
    ['Доступ не активирован', 'Доступ не активовано'],
    ['Добро пожаловать', 'Вітаємо'],
    ['Неверный email или пароль', 'Невірний email або пароль'],
    ['Неизвестная ошибка', 'Невідома помилка'],
    ['Файл удалён', 'Файл видалено'],
    ['Заявка удалена', 'Заявку видалено'],
    ['Заявка в архиве', 'Заявка в архіві'],
    ['Управление персоналом компании', 'Управління персоналом компанії'],
    ['Заявки на материалы', 'Заявки на матеріали'],
    ['Заявок на материалы нет', 'Заявок на матеріали немає'],
    ['Заявок на финансирование нет', 'Заявок на фінансування немає'],
    ['выдаёт финансист', 'видає фінансист'],
    ['Заявки на подотчёт для выполнения работ', 'Заявки на підзвіт для виконання робіт']
];

// =====================================================================
// ПЕРЕВОД СТРОК
// =====================================================================

// Границы слова для кириллицы: \b в JS на неё не реагирует.
const WORD_CHAR = '[А-Яа-яЁёІіЇїЄєҐґA-Za-z0-9]';

function escapeRegExp(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Длинные фразы — первыми, иначе «Мои заявки» съело бы начало
// «Мои заявки на финансирование».
const PHRASE_RULES = PHRASES
    .slice()
    .sort((a, b) => b[0].length - a[0].length)
    .map(([ru, uk]) => ({
        ru,
        uk,
        re: new RegExp(`(?<!${WORD_CHAR})${escapeRegExp(ru)}(?!${WORD_CHAR})`, 'g')
    }));

/**
 * Перевод по ключу словаря: t('invoice.pay') → «✅ Оплачено» / «✅ Сплачено».
 * Нет ключа — вернётся сам ключ: это заметно в интерфейсе и легко искать.
 */
export function t(key, params = {}) {
    const dict = DICT[currentLang] || {};
    const fallback = DICT[DEFAULT_LANG] || {};
    let text = dict[key] || fallback[key] || key;

    Object.keys(params).forEach(name => {
        text = text.split(`{${name}}`).join(String(params[name]));
    });

    return text;
}

/**
 * Перевод «свободного» текста по фразовому словарю — для старых модулей,
 * где строки написаны прямо в коде. Нет фразы в словаре — текст не меняется,
 * поэтому непереведённый интерфейс выглядит как русский, а не как ошибка.
 */
export function translateText(text) {
    if (!text || currentLang === DEFAULT_LANG) return text;

    let out = String(text);
    for (const rule of PHRASE_RULES) {
        if (out.indexOf(rule.ru) === -1) continue;
        out = out.replace(rule.re, rule.uk);
    }
    return out;
}

export function getLang() {
    return currentLang;
}

/** Язык по умолчанию (русский) — при нём DOM не переводим вовсе. */
export function isDefaultLang() {
    return currentLang === DEFAULT_LANG;
}

/**
 * Переключение языка. DOM переводится сразу (translateTree), а подписчики
 * могут перерисовать свои блоки, если хотят строки из t().
 */
export function setLang(code) {
    const next = DICT[code] ? code : DEFAULT_LANG;
    if (next === currentLang) return currentLang;

    currentLang = next;

    try {
        localStorage.setItem(STORAGE_KEY, next);
    } catch {
        // Приватный режим / выключенное хранилище — просто не запоминаем выбор
    }

    applyLangToDocument();
    observers.forEach(fn => {
        try { fn(next); } catch (err) { console.warn('[i18n] подписчик упал:', err); }
    });

    return currentLang;
}

/** Подписка на смену языка (например, чтобы перерисовать открытый экран). */
export function onLangChange(fn) {
    if (typeof fn === 'function') observers.push(fn);
}

// =====================================================================
// ПЕРЕВОД ГОТОВОГО DOM
// =====================================================================
// Русский текст каждого узла запоминается: так можно вернуться к русскому
// без перезагрузки, и повторный проход не «переводит перевод».

const originalText = new WeakMap();   // TextNode → исходный текст
const originalAttr = new WeakMap();   // Element  → { attr: исходное значение }
const originalKeyed = new WeakMap();  // Element с data-i18n → исходный текст

const TRANSLATED_ATTRS = ['placeholder', 'title', 'aria-label'];
const SKIP_TAGS = ['SCRIPT', 'STYLE', 'TEXTAREA'];

function isTranslatable(element) {
    if (!element || !element.tagName) return false;
    if (SKIP_TAGS.includes(element.tagName)) return false;
    if (element.closest('[data-i18n-skip]')) return false;
    return true;
}

/** Целевой текст: на русском — исходный, на украинском — переведённый. */
function targetText(original) {
    return currentLang === DEFAULT_LANG ? original : translateText(original);
}

function collectTextNodes(root) {
    const doc = root.ownerDocument || document;
    const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
            const parent = node.parentElement;
            if (!parent || !isTranslatable(parent)) return NodeFilter.FILTER_REJECT;
            // Текст элементов с data-i18n подставляется по ключу словаря
            if (parent.hasAttribute('data-i18n')) return NodeFilter.FILTER_REJECT;
            return NodeFilter.FILTER_ACCEPT;
        }
    });

    const nodes = [];
    let node;
    while ((node = walker.nextNode())) nodes.push(node);
    return nodes;
}

function translateTextNode(node) {
    const parent = node.parentElement;
    if (parent && (!isTranslatable(parent) || parent.hasAttribute('data-i18n'))) return;

    if (!originalText.has(node)) originalText.set(node, node.nodeValue);

    const next = targetText(originalText.get(node));
    if (node.nodeValue !== next) node.nodeValue = next;
}

function translateKeyed(element) {
    if (!element || !element.getAttribute) return;

    const key = element.getAttribute('data-i18n');
    if (!key) return;

    if (!originalKeyed.has(element)) originalKeyed.set(element, element.textContent.trim());

    const original = originalKeyed.get(element);
    const next = currentLang === DEFAULT_LANG ? original : t(key);

    if (element.textContent.trim() !== next) element.textContent = next;
}

function translateAttributes(element) {
    TRANSLATED_ATTRS.forEach(attr => {
        const current = element.getAttribute(attr);
        if (current === null) return;

        let store = originalAttr.get(element);
        if (!store) { store = {}; originalAttr.set(element, store); }
        if (!(attr in store)) store[attr] = current;

        const next = targetText(store[attr]);
        if (current !== next) element.setAttribute(attr, next);
    });
}

/**
 * Перевод поддерева. Вызывается при смене языка и MutationObserver'ом для
 * каждого нового элемента, который отрисовал модуль.
 */
export function translateTree(root) {
    if (!root) return;

    // Отдельный текстовый узел (приходит из MutationObserver)
    if (root.nodeType === Node.TEXT_NODE) {
        translateTextNode(root);
        return;
    }

    if (!root.querySelectorAll) return;

    translateKeyed(root);
    collectTextNodes(root).forEach(translateTextNode);

    root.querySelectorAll('[data-i18n]').forEach(translateKeyed);
    root.querySelectorAll('*').forEach(element => {
        if (isTranslatable(element)) translateAttributes(element);
    });
}

/** То же, что translateTree, но с понятным именем для вызовов извне. */
export function refreshTranslations(root = document.body) {
    translateTree(root);
}

function applyLangToDocument() {
    if (typeof document === 'undefined') return;

    document.documentElement.setAttribute('lang', currentLang);

    // Заголовок вкладки браузера (в DOM тела его нет)
    if (originalTitle === null && document.title) originalTitle = document.title;
    if (originalTitle) document.title = targetText(originalTitle);

    if (document.body) translateTree(document.body);
}

// =====================================================================
// НАБЛЮДЕНИЕ ЗА НОВЫМИ ЭЛЕМЕНТАМИ
// =====================================================================
// Модули рисуют списки и карточки «на лету», поэтому переводим не только при
// смене языка, но и каждый новый узел: иначе после перерисовки текст снова
// стал бы русским.

let translator = null;
let originalTitle = null;

function startTranslator() {
    if (translator || typeof MutationObserver === 'undefined' || !document.body) return;

    let scheduled = false;
    const pending = new Set();
    const schedule = typeof requestAnimationFrame === 'function'
        ? requestAnimationFrame
        : (fn) => setTimeout(fn, 16);

    translator = new MutationObserver(mutations => {
        // На русском переводить нечего: модули и так пишут по-русски
        if (currentLang === DEFAULT_LANG) return;

        mutations.forEach(mutation => {
            if (mutation.type === 'characterData') {
                const node = mutation.target;
                const recorded = originalText.get(node);
                const expected = recorded === undefined ? undefined : targetText(recorded);

                // Свою же подстановку игнорируем: иначе «оригиналом» станет уже
                // переведённый текст и вернуться на русский будет нельзя.
                if (expected !== undefined && node.nodeValue === expected) return;

                // Текст заменил модуль — прежний оригинал больше не актуален
                originalText.delete(node);
                pending.add(node);
                return;
            }
            mutation.addedNodes.forEach(node => pending.add(node));
        });

        if (pending.size === 0 || scheduled) return;

        scheduled = true;
        schedule(() => {
            scheduled = false;
            const items = [...pending];
            pending.clear();
            items.forEach(item => translateTree(item));
        });
    });

    translator.observe(document.body, { childList: true, subtree: true, characterData: true });
}

/**
 * Вызывается один раз при старте приложения (js/main.js): читает выбор
 * сотрудника из localStorage и включает перевод новых элементов.
 */
export function initI18n() {
    let saved = null;

    try {
        saved = localStorage.getItem(STORAGE_KEY);
    } catch {
        // Хранилище недоступно — работаем на языке по умолчанию
    }

    currentLang = DICT[saved] ? saved : DEFAULT_LANG;

    applyLangToDocument();
    startTranslator();

    return currentLang;
}

// Отладка через консоль: i18n.setLang('uk'), i18n.t('invoice.pay')
if (typeof window !== 'undefined') {
    window.i18n = { t, translateText, getLang, setLang, initI18n, refreshTranslations, LANGUAGES };
}
