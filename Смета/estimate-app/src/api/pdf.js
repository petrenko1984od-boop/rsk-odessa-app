const API_BASE = 'http://localhost:3001/api'

export const getPdfUrl = (vedomostId, type = 'koshtorys') => {
  return `${API_BASE}/pdf/${vedomostId}/pdf?type=${type}`
}

export const openPdf = (vedomostId, type) => {
  window.open(getPdfUrl(vedomostId, type), '_blank')
}