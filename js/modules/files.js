// =====================================================================
// МОДУЛЬ: ФАЙЛЫ ОБЪЕКТА
// =====================================================================
// Раздел «📁 Файлы» в карточке объекта.
//
// Возможности:
//   1. СМЕТА (Excel) — загружают Админ / Гл. инженер / Инженер ПТО.
//      Скачивать могут все (прораб — только PDF).
//   2. ДОП. ФАЙЛЫ (проекты, наряды, фото, другое) — загружают редакторы,
//      просматривают и скачивают все.
//
// Библиотеки: XLSX (парсинг сметы), jsPDF (генерация PDF).
// =====================================================================

import { db } from '../database.js';
import {
    log, toast, escapeHtml, showModal, hideModal,
    formatDate, formatMoney
} from '../utils.js';
import { getEmployee } from '../permissions.js';
import { CONFIG } from '../config.js';

// =====================================================================
// СОСТОЯНИЕ
// =====================================================================

let currentProjectFiles = []; // Доп. файлы текущего объекта

// =====================================================================
// ПРАВА
// =====================================================================

/**
 * Может ли текущий пользователь загружать/удалять файлы?
 * Только Админ / Гл. инженер / Инженер ПТО.
 */
export function canManageFiles() {
    const role = getEmployee()?.position;
    if (!role) return false;
    return role === 'Администратор'
        || role === 'Главный инженер'
        || role === 'Инженер ПТО';
}

// =====================================================================
// СМЕТА: СКАЧИВАНИЕ PDF
// =====================================================================

/**
 * Скачивает смету в PDF.
 * Берёт xlsx из Storage, парсит через XLSX, генерирует PDF через jsPDF.
 */
export async function downloadEstimatePDF() {
    const project = window.__getCurrentProject?.();
    if (!project || !project.estimate_file_path) {
        toast('Смета не загружена', 'error');
        return;
    }

    if (typeof XLSX === 'undefined' || typeof window.jspdf === 'undefined') {
        toast('Библиотеки XLSX или jsPDF не загружены', 'error');
        return;
    }

    toast('Готовим PDF...', 'info');

    try {
        // 1. Скачиваем файл сметы из Storage
        const { blob, error } = await db.downloadFile(
            CONFIG.STORAGE.ESTIMATES_BUCKET,
            project.estimate_file_path
        );

        if (error || !blob) {
            toast('Не удалось скачать файл сметы', 'error');
            return;
        }

        // 2. Парсим Excel
        const arrayBuffer = await blob.arrayBuffer();
        const data = new Uint8Array(arrayBuffer);
        const workbook = XLSX.read(data, { type: 'array' });
        const firstSheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[firstSheetName];

        // Преобразуем в HTML-таблицу
        const htmlTable = XLSX.utils.sheet_to_html(worksheet, { editable: false });

        // 3. Создаём временный контейнер для PDF
        const wrapper = document.createElement('div');
        wrapper.style.position = 'fixed';
        wrapper.style.left = '-9999px';
        wrapper.style.top = '0';
        wrapper.style.width = '1400px';
        wrapper.style.padding = '30px';
        wrapper.style.background = '#ffffff';
        wrapper.style.fontFamily = 'system-ui, -apple-system, sans-serif';
        wrapper.style.color = '#111827';

        wrapper.innerHTML = `
            <div style="margin-bottom: 20px; padding-bottom: 15px; border-bottom: 2px solid #15803d;">
                <div style="font-size: 24px; font-weight: 700; color: #166534;">
                    📊 Смета
                </div>
                <div style="font-size: 16px; color: #374151; margin-top: 6px;">
                    Объект: <strong>${escapeHtml(project.name)}</strong>
                </div>
                <div style="font-size: 12px; color: #6b7280; margin-top: 4px;">
                    Дата формирования: ${new Date().toLocaleDateString('ru-RU')}
                </div>
            </div>
            <div style="font-size: 10px;">
                ${htmlTable}
            </div>
        `;

        document.body.appendChild(wrapper);
        await new Promise(resolve => setTimeout(resolve, 400));

        // 4. Рендерим в PDF через html2canvas + jsPDF
        const canvas = await html2canvas(wrapper, {
            scale: 2,
            useCORS: true,
            backgroundColor: '#ffffff',
            logging: false,
            windowWidth: 1400
        });

        const { jsPDF } = window.jspdf;
        const pdf = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });

        const pageWidth = pdf.internal.pageSize.getWidth();
        const pageHeight = pdf.internal.pageSize.getHeight();
        const imgWidth = pageWidth - 20;
        const imgHeight = (canvas.height * imgWidth) / canvas.width;
        const imgData = canvas.toDataURL('image/png');

        let heightLeft = imgHeight;
        let position = 10;

        pdf.addImage(imgData, 'PNG', 10, position, imgWidth, imgHeight);
        heightLeft -= (pageHeight - 20);

        while (heightLeft > 0) {
            position = heightLeft - imgHeight + 10;
            pdf.addPage();
            pdf.addImage(imgData, 'PNG', 10, position, imgWidth, imgHeight);
            heightLeft -= (pageHeight - 20);
        }

        // 5. Скачиваем
        const safeName = project.name.replace(/[^a-zA-Z0-9а-яА-Я\s]/g, '').trim().replace(/\s+/g, '_');
        pdf.save(`Смета_${safeName}_${new Date().toISOString().split('T')[0]}.pdf`);

        document.body.removeChild(wrapper);

        log.info('✅ Смета скачана в PDF');
        toast('PDF скачан', 'success');

    } catch (err) {
        log.error('Ошибка генерации PDF сметы:', err);
        toast('Ошибка генерации PDF: ' + err.message, 'error');
    }
}

// =====================================================================
// ДОП. ФАЙЛЫ ОБЪЕКТА
// =====================================================================

/**
 * Категории файлов.
 */
const FILE_CATEGORIES = {
    'project': { label: '📐 Проекты',  bucket: 'project-files' },
    'order':   { label: '📋 Наряды',   bucket: 'project-files' },
    'photo':   { label: '📸 Фото',     bucket: 'project-files' },
    'other':   { label: '📄 Другое',   bucket: 'project-files' }
};

/**
 * Загружает список доп. файлов объекта из БД.
 */
export async function loadProjectFiles(projectId) {
    const { data, error } = await db.select('project_files', {
        filters: { project_id: projectId },
        orderBy: { column: 'created_at', asc: false }
    });

    if (error) {
        log.error('Ошибка загрузки файлов:', error.message);
        return [];
    }

    currentProjectFiles = data || [];
    return currentProjectFiles;
}

/**
 * Отрисовывает блок доп. файлов (по категориям).
 */
export async function renderProjectFiles(project) {
    const container = document.getElementById('proj-files-list');
    if (!container) return;

    const files = await loadProjectFiles(project.id);
    const canManage = canManageFiles();

    // Кнопка загрузки (только для редакторов)
    const uploadBtn = document.getElementById('upload-file-btn');
    if (uploadBtn) {
        uploadBtn.style.display = canManage ? '' : 'none';
    }

    // Группируем по категориям
    const grouped = { project: [], order: [], photo: [], other: [] };
    files.forEach(f => {
        const cat = f.category || 'other';
        if (grouped[cat]) grouped[cat].push(f);
    });

    let html = '';

    for (const [catKey, catInfo] of Object.entries(FILE_CATEGORIES)) {
        const catFiles = grouped[catKey] || [];

        html += `
            <div class="space-y-2">
                <h4 class="text-xs font-bold text-gray-700 uppercase tracking-wider flex items-center gap-2">
                    ${catInfo.label}
                    <span class="text-[10px] bg-gray-100 text-gray-500 px-2 py-0.5 rounded font-normal">${catFiles.length}</span>
                </h4>
                ${catFiles.length > 0
                    ? catFiles.map(f => renderFileRow(f, canManage)).join('')
                    : `<p class="text-xs text-gray-400 italic pl-2">Нет файлов</p>`}
            </div>
        `;
    }

    container.innerHTML = html;
}

/**
 * Отрисовка одной строки файла.
 */
function renderFileRow(file, canManage) {
    const sizeMb = (Number(file.file_size) / 1024 / 1024).toFixed(2);
    const uploadedAt = formatDate(file.created_at);
    const icon = getFileIcon(file.file_name);

    return `
        <div class="flex items-center justify-between bg-white border rounded-lg p-2.5 text-xs hover:bg-emerald-50/50 transition">
            <div class="flex items-center gap-2 min-w-0 flex-1">
                <span class="text-lg shrink-0">${icon}</span>
                <div class="min-w-0">
                    <p class="font-semibold text-gray-800 truncate" title="${escapeHtml(file.file_name)}">${escapeHtml(file.file_name)}</p>
                    <p class="text-[10px] text-gray-400">${sizeMb} МБ · ${uploadedAt}</p>
                </div>
            </div>
            <div class="flex gap-1 shrink-0">
                <button onclick="window.downloadProjectFile(${file.id})"
                        class="bg-emerald-100 hover:bg-emerald-200 text-[#15803d] px-2 py-1 rounded text-[11px] font-semibold transition"
                        title="Скачать">
                    📥
                </button>
                ${canManage ? `
                    <button onclick="window.deleteProjectFile(${file.id})"
                            class="bg-red-50 hover:bg-red-100 text-red-500 px-2 py-1 rounded text-[11px] font-semibold transition"
                            title="Удалить">
                        🗑
                    </button>
                ` : ''}
            </div>
        </div>
    `;
}

/**
 * Иконка по расширению файла.
 */
function getFileIcon(fileName) {
    const ext = String(fileName).toLowerCase().split('.').pop();
    if (['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext)) return '📸';
    if (['pdf'].includes(ext)) return '📕';
    if (['xlsx', 'xls'].includes(ext)) return '📊';
    if (['doc', 'docx'].includes(ext)) return '📝';
    if (['zip', 'rar', '7z'].includes(ext)) return '📦';
    return '📄';
}

// =====================================================================
// ЗАГРУЗКА ДОП. ФАЙЛА
// =====================================================================

/**
 * Открывает модалку загрузки файла для выбранной категории.
 */
export function openUploadFileModal(category) {
    if (!canManageFiles()) {
        toast('Нет прав на загрузку файлов', 'error');
        return;
    }

    const catInfo = FILE_CATEGORIES[category];
    if (!catInfo) {
        toast('Неверная категория', 'error');
        return;
    }

    document.getElementById('upload-file-category').value = category;
    document.getElementById('upload-file-modal-title').textContent = `📤 Загрузить в «${catInfo.label}»`;
    document.getElementById('upload-file-input').value = '';
    document.getElementById('upload-file-description').value = '';

    showModal('upload-file-modal');
}

/**
 * Сохраняет доп. файл в Storage + записывает в БД.
 */
export async function uploadProjectFile(event) {
    event.preventDefault();

    if (!canManageFiles()) {
        toast('Нет прав', 'error');
        return;
    }

    const emp = getEmployee();
    const project = window.__getCurrentProject?.();
    if (!emp || !project) {
        toast('Не удалось определить сотрудника или объект', 'error');
        return;
    }

    const category = document.getElementById('upload-file-category').value;
    const fileInput = document.getElementById('upload-file-input');
    const description = document.getElementById('upload-file-description').value.trim();

    if (!fileInput.files || fileInput.files.length === 0) {
        toast('Выбери файл', 'error');
        return;
    }

    const file = fileInput.files[0];

    // Проверка размера (50 МБ)
    const maxSize = 50 * 1024 * 1024;
    if (file.size > maxSize) {
        toast(`Файл больше 50 МБ (${(file.size / 1024 / 1024).toFixed(1)} МБ)`, 'error');
        return;
    }

    const form = event.target;
    const submitBtn = form.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Загружаем...';

    // Формируем путь: project_<id>/<category>/<timestamp>_<safeName>
    const safeName = sanitizeFileName(file.name);
    const path = `project_${project.id}/${category}/${Date.now()}_${safeName}`;

    // 1. Загружаем в Storage
    const uploadResult = await db.uploadFile('project-files', path, file);

    submitBtn.disabled = false;
    submitBtn.textContent = '📤 Загрузить';

    if (uploadResult.error) {
        toast('Ошибка загрузки файла: ' + uploadResult.error.message, 'error');
        return;
    }

    // 2. Записываем в БД
    const { error: dbError } = await db.insert('project_files', {
        project_id: project.id,
        file_path: uploadResult.path,
        file_name: file.name,
        file_size: file.size,
        mime_type: file.type || null,
        category: category,
        description: description || null,
        uploaded_by_employee_id: emp.id
    });

    if (dbError) {
        log.error('Ошибка записи в БД:', dbError.message);
        toast('Файл загружен, но запись не создана', 'warning');
        return;
    }

    log.info('✅ Файл загружен:', file.name);
    toast(`Файл «${file.name}» загружен`, 'success');

    hideModal('upload-file-modal');
    form.reset();

    // Обновляем список
    await renderProjectFiles(project);
}

// =====================================================================
// СКАЧИВАНИЕ ДОП. ФАЙЛА
// =====================================================================

/**
 * Скачивает файл (получает подписанную ссылку и открывает).
 */
export async function downloadProjectFile(fileId) {
    const file = currentProjectFiles.find(f => f.id === fileId);
    if (!file) {
        toast('Файл не найден', 'error');
        return;
    }

    toast('Готовим ссылку...', 'info');

    const { url, error } = await db.getFileUrl('project-files', file.file_path, 3600);

    if (error || !url) {
        toast('Не удалось получить ссылку на файл', 'error');
        return;
    }

    // Открываем в новой вкладке (браузер либо покажет, либо скачает)
    window.open(url, '_blank');

    log.info('✅ Файл скачан:', file.file_name);
}

// =====================================================================
// УДАЛЕНИЕ ДОП. ФАЙЛА
// =====================================================================

/**
 * Удаляет файл из Storage и БД.
 */
export async function deleteProjectFile(fileId) {
    if (!canManageFiles()) {
        toast('Нет прав на удаление', 'error');
        return;
    }

    const file = currentProjectFiles.find(f => f.id === fileId);
    if (!file) {
        toast('Файл не найден', 'error');
        return;
    }

    if (!confirm(`Удалить файл «${file.file_name}»?\n\nЭто действие нельзя отменить.`)) return;

    // 1. Удаляем из Storage
    const delStorage = await db.deleteFile('project-files', file.file_path);

    if (delStorage.error) {
        log.warn('Не удалось удалить файл из Storage:', delStorage.error.message);
    }

    // 2. Удаляем из БД
    const { error } = await db.remove('project_files', { id: fileId });

    if (error) {
        toast('Ошибка удаления: ' + error.message, 'error');
        return;
    }

    toast('Файл удалён', 'success');

    // Обновляем список
    const project = window.__getCurrentProject?.();
    if (project) await renderProjectFiles(project);
}

// =====================================================================
// УТИЛИТА: ОЧИСТКА ИМЕНИ ФАЙЛА
// =====================================================================

function sanitizeFileName(originalName) {
    const lastDot = originalName.lastIndexOf('.');
    const namePart = lastDot > 0 ? originalName.slice(0, lastDot) : originalName;
    const ext = lastDot > 0 ? originalName.slice(lastDot) : '';

    const translitMap = {
        'а':'a','б':'b','в':'v','г':'g','д':'d','е':'e','ё':'e','ж':'zh','з':'z',
        'и':'i','й':'y','к':'k','л':'l','м':'m','н':'n','о':'o','п':'p','р':'r',
        'с':'s','т':'t','у':'u','ф':'f','х':'h','ц':'ts','ч':'ch','ш':'sh','щ':'shch',
        'ъ':'','ы':'y','ь':'','э':'e','ю':'yu','я':'ya',
        'А':'A','Б':'B','В':'V','Г':'G','Д':'D','Е':'E','Ё':'E','Ж':'Zh','З':'Z',
        'И':'I','Й':'Y','К':'K','Л':'L','М':'M','Н':'N','О':'O','П':'P','Р':'R',
        'С':'S','Т':'T','У':'U','Ф':'F','Х':'H','Ц':'Ts','Ч':'Ch','Ш':'Sh','Щ':'Shch',
        'Ъ':'','Ы':'Y','Ь':'','Э':'E','Ю':'Yu','Я':'Ya'
    };

    let result = '';
    for (const ch of namePart) {
        if (translitMap[ch]) result += translitMap[ch];
        else if (/[a-zA-Z0-9._-]/.test(ch)) result += ch;
        else result += '_';
    }
    result = result.replace(/_+/g, '_').replace(/^_|_$/g, '');
    if (!result) result = 'file';
    if (result.length > 80) result = result.slice(0, 80);

    return result + ext.toLowerCase();
}

// =====================================================================
// ГЛОБАЛЬНЫЕ ФУНКЦИИ
// =====================================================================

window.downloadEstimatePDF = downloadEstimatePDF;
window.openUploadFileModal = openUploadFileModal;
window.uploadProjectFile = uploadProjectFile;
window.downloadProjectFile = downloadProjectFile;
window.deleteProjectFile = deleteProjectFile;
window.canManageFilesFromFiles = canManageFiles;