// Форматирование денег в украинском формате: 1 500,00 ₴
export const formatMoney = (value) => {
  const num = parseFloat(value) || 0
  return (
    num.toLocaleString('uk-UA', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }) + ' ₴'
  )
}

// Форматирование количества без валюты
export const formatNumber = (value, decimals = 2) => {
  const num = parseFloat(value) || 0
  return num.toLocaleString('uk-UA', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })
}

// Форматирование даты в украинском формате
export const formatDate = (dateString) => {
  if (!dateString) return ''
  return new Date(dateString).toLocaleDateString('uk-UA', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  })
}