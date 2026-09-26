const API_BASE = 'http://localhost:3001/api'

/**
 * Строит URL для экспорта
 * @param {string} vedomostId — ID ведомости
 * @param {object} options — { type, color, format }
 *   type: '6graph' | '9graph' | 'naryad' | 'vedomist'
 *   color: 'violet' | 'blue' | 'emerald' | 'slate' | 'amber' | 'yellow' | 'none'
 *   format: 'pdf' | 'excel'
 */
export const buildExportUrl = (vedomostId, { type, color, format }) => {
  const params = new URLSearchParams()
  params.set('type', type)
  if (color && color !== 'none') params.set('color', color)

  if (format === 'pdf') {
    // PDF: /api/pdf/:id/pdf?type=...
    return `${API_BASE}/pdf/${vedomostId}/pdf?${params.toString()}`
  } else {
    // Excel: /api/excel/:id?type=...
    return `${API_BASE}/excel/${vedomostId}?${params.toString()}`
  }
}

/**
 * Открывает URL для скачивания
 */
export const downloadExport = (vedomostId, options) => {
  const url = buildExportUrl(vedomostId, options)
  window.open(url, '_blank')
}