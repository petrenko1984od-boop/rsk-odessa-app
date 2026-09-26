const express = require('express')
const router = express.Router()
const path = require('path')
const fs = require('fs')
const prisma = require('../prisma')
const ExcelJS = require('exceljs')

// ============ ПАЛИТРЫ ЦВЕТОВ ============

const COLOR_PALETTES = {
  violet: { bg: '7C3AED', text: 'FFFFFF' },
  blue: { bg: '2563EB', text: 'FFFFFF' },
  emerald: { bg: '059669', text: 'FFFFFF' },
  slate: { bg: '1E293B', text: 'FFFFFF' },
  amber: { bg: 'D97706', text: 'FFFFFF' },
  yellow: { bg: 'EAB308', text: '000000' },
  none: { bg: null, text: '000000' },
}

function getPalette(colorName) {
  return COLOR_PALETTES[colorName] || COLOR_PALETTES.none
}

const BORDER_THIN = {
  top: { style: 'thin', color: { argb: 'FF999999' } },
  left: { style: 'thin', color: { argb: 'FF999999' } },
  bottom: { style: 'thin', color: { argb: 'FF999999' } },
  right: { style: 'thin', color: { argb: 'FF999999' } },
}

const MONEY_FORMAT = '#,##0.00'
const INT_FORMAT = '0'

// ============ УТИЛИТЫ ============

function baseLabel(base) {
  if (base === 'works') return 'від робіт'
  if (base === 'materials') return 'від матеріалів'
  if (base === 'both') return 'від робіт і матеріалів'
  return ''
}

function dateUk(d) {
  const date = new Date(d)
  return date.toLocaleDateString('uk-UA', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  })
}

function roundUp(value) {
  const num = parseFloat(value) || 0
  return Math.ceil(num)
}

function calcLimitAmount(percent, base, workSum, matSum) {
  const p = parseFloat(percent) || 0
  if (p <= 0) return 0
  if (base === 'works') return workSum * (p / 100)
  if (base === 'materials') return matSum * (p / 100)
  return (workSum + matSum) * (p / 100)
}

function calcTotals(vedomost) {
  let workKoshtorys = 0
  let matKoshtorys = 0
  let workNaryad = 0
  let matNaryad = 0

  vedomost.sections?.forEach((section) => {
    section.items?.forEach((item) => {
      const qty = item.quantity || 0
      workKoshtorys += qty * (item.priceClient || 0)
      workNaryad += qty * (item.priceWorker || 0)

      item.materials?.forEach((mat) => {
        if (mat.isCustomerSupplied) return
        const mq = roundUp(mat.quantity || 0)
        matKoshtorys += mq * (mat.priceClient || 0)
        matNaryad += mq * (mat.pricePurchase || 0)
      })
    })
  })

  const limits = (vedomost.limits || []).map((lim) => {
    const amount = calcLimitAmount(lim.percent, lim.base, workKoshtorys, matKoshtorys)
    return { ...lim, amount }
  })

  const limitsTotal = limits.reduce((s, l) => s + l.amount, 0)
  const subTotal = workKoshtorys + matKoshtorys + limitsTotal
  const vat = vedomost.vatPercent > 0 ? subTotal * (vedomost.vatPercent / 100) : 0
  const grandTotal = subTotal + vat

  return {
    workKoshtorys,
    matKoshtorys,
    workNaryad,
    matNaryad,
    limits,
    limitsTotal,
    subTotal,
    vat,
    grandTotal,
    totalNaryad: workNaryad + matNaryad,
    profit: workKoshtorys + matKoshtorys - workNaryad - matNaryad,
  }
}

function getLogoBase64(companySettings) {
  if (!companySettings?.logoUrl) return null
  try {
    const logoPath = path.join(__dirname, '../..', companySettings.logoUrl)
    if (fs.existsSync(logoPath)) {
      const ext = path.extname(logoPath).toLowerCase().replace('.', '')
      const base64 = fs.readFileSync(logoPath).toString('base64')
      return { base64, ext: ext === 'jpg' ? 'jpeg' : ext }
    }
  } catch (err) {
    console.error('Помилка читання логотипу:', err)
  }
  return null
}

// ============ СТИЛІ ============

function styleTableHeader(cell, palette, align = 'center') {
  cell.font = {
    name: 'Calibri',
    size: 10,
    bold: true,
    color: { argb: 'FF' + palette.text },
  }
  cell.alignment = { vertical: 'middle', horizontal: align, wrapText: true }
  cell.border = BORDER_THIN

  if (palette.bg) {
    cell.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF' + palette.bg },
    }
  }
}

function styleCell(cell, opts = {}) {
  const { align = 'left', bold = false, numFmt = null } = opts
  cell.font = {
    name: 'Calibri',
    size: 10,
    bold,
    color: { argb: 'FF000000' },
  }
  cell.alignment = { vertical: 'middle', horizontal: align, wrapText: true }
  cell.border = BORDER_THIN
  if (numFmt) cell.numFmt = numFmt
}

function styleTotalCell(cell, align = 'right', bold = true) {
  cell.font = {
    name: 'Calibri',
    size: 10,
    bold,
    color: { argb: 'FF000000' },
  }
  cell.alignment = { vertical: 'middle', horizontal: align, wrapText: true }
  cell.border = BORDER_THIN
}

function styleGrandTotalCell(cell, align = 'right') {
  cell.font = {
    name: 'Calibri',
    size: 14,
    bold: true,
    color: { argb: 'FF000000' },
  }
  cell.alignment = { vertical: 'middle', horizontal: align, wrapText: true }
}

// ============ ШАПКА ============

function buildHeaderRows(workbook, sheet, vedomost, companySettings, docTitle, lastCol) {
  let currentRow = 1

  const logo = getLogoBase64(companySettings)

  if (logo) {
    const imageId = workbook.addImage({
      base64: logo.base64,
      extension: logo.ext,
    })
    sheet.addImage(imageId, {
      tl: { col: 0, row: currentRow - 1 },
      ext: { width: 80, height: 80 },
    })
  }

  // lastCol теперь параметр (6 или 9)
  const rekvizitStartCol = lastCol >= 9 ? lastCol - 4 : Math.max(4, lastCol - 2)

  const nameCell = sheet.getCell(currentRow, rekvizitStartCol)
  nameCell.value = companySettings?.companyName || ''
  nameCell.font = { name: 'Calibri', size: 14, bold: true, color: { argb: 'FF000000' } }
  nameCell.alignment = { vertical: 'middle', horizontal: 'right' }
  sheet.mergeCells(currentRow, rekvizitStartCol, currentRow, lastCol)

  currentRow++

  if (companySettings?.phone) {
    const cell = sheet.getCell(currentRow, rekvizitStartCol)
    cell.value = companySettings.phone
    cell.font = { name: 'Calibri', size: 11, color: { argb: 'FF333333' } }
    cell.alignment = { vertical: 'middle', horizontal: 'right' }
    sheet.mergeCells(currentRow, rekvizitStartCol, currentRow, lastCol)
    currentRow++
  }

  if (companySettings?.website) {
    const cell = sheet.getCell(currentRow, rekvizitStartCol)
    cell.value = companySettings.website
    cell.font = { name: 'Calibri', size: 11, color: { argb: 'FF333333' } }
    cell.alignment = { vertical: 'middle', horizontal: 'right' }
    sheet.mergeCells(currentRow, rekvizitStartCol, currentRow, lastCol)
    currentRow++
  }

  if (companySettings?.email) {
    const cell = sheet.getCell(currentRow, rekvizitStartCol)
    cell.value = companySettings.email
    cell.font = { name: 'Calibri', size: 11, color: { argb: 'FF333333' } }
    cell.alignment = { vertical: 'middle', horizontal: 'right' }
    sheet.mergeCells(currentRow, rekvizitStartCol, currentRow, lastCol)
    currentRow++
  }

  if (companySettings?.address) {
    const cell = sheet.getCell(currentRow, rekvizitStartCol)
    cell.value = companySettings.address
    cell.font = { name: 'Calibri', size: 11, color: { argb: 'FF333333' } }
    cell.alignment = { vertical: 'middle', horizontal: 'right' }
    sheet.mergeCells(currentRow, rekvizitStartCol, currentRow, lastCol)
    currentRow++
  }

  if (currentRow < 5) currentRow = 5
  else currentRow += 1

  const titleCell = sheet.getCell(currentRow, 1)
  titleCell.value = docTitle
  titleCell.font = { name: 'Calibri', size: 18, bold: true, color: { argb: 'FF000000' } }
  titleCell.alignment = { vertical: 'middle', horizontal: 'left' }
  sheet.mergeCells(currentRow, 1, currentRow, Math.floor(lastCol / 2))

  const dateCell = sheet.getCell(currentRow, lastCol - 1)
  dateCell.value = 'Дата: ' + dateUk(vedomost.createdAt)
  dateCell.font = { name: 'Calibri', size: 11, color: { argb: 'FF333333' } }
  dateCell.alignment = { vertical: 'middle', horizontal: 'right' }
  sheet.mergeCells(currentRow, lastCol - 1, currentRow, lastCol)

  currentRow += 1

  const numberCell = sheet.getCell(currentRow, 1)
  numberCell.value = '№ ' + (vedomost.number || '—')
  numberCell.font = { name: 'Calibri', size: 11, color: { argb: 'FF333333' } }
  numberCell.alignment = { vertical: 'middle', horizontal: 'left' }

  currentRow += 2

  // Метка + значение в одну ячейку
  const infoRows = [
    ['Назва:', vedomost.title || '—'],
    ["Об'єкт:", vedomost.object || '—'],
    ['Замовник:', vedomost.client?.name || '—'],
  ]

  infoRows.forEach(([label, value]) => {
    const cell = sheet.getCell(currentRow, 1)
    cell.value = label + ' ' + value
    cell.font = { name: 'Calibri', size: 11, color: { argb: 'FF000000' } }
    cell.alignment = { vertical: 'middle', horizontal: 'left' }
    sheet.mergeCells(currentRow, 1, currentRow, lastCol)
    currentRow += 1
  })

  currentRow += 1

  return currentRow
}

// ============ 6-ТИ ГРАФКА ============

function buildKoshtorysExcel(workbook, sheet, vedomost, companySettings, totals, palette) {
  sheet.columns = [
    { width: 6 },
    { width: 45 },
    { width: 10 },
    { width: 12 },
    { width: 18 },
    { width: 18 },
  ]

  let row = buildHeaderRows(workbook, sheet, vedomost, companySettings, 'КОШТОРИС', 6)

  const subCell = sheet.getCell(row, 1)
  subCell.value = 'Роботи та матеріали'
  subCell.font = { name: 'Calibri', size: 13, bold: true, color: { argb: 'FF000000' } }
  sheet.mergeCells(row, 1, row, 6)
  row += 2

  vedomost.sections?.forEach((section, idx) => {
    const sectionCell = sheet.getCell(row, 1)
    sectionCell.value = `${idx + 1}. ${section.name || 'Без назви'}`
    sectionCell.font = { name: 'Calibri', size: 11, bold: true, color: { argb: 'FF000000' } }
    sheet.mergeCells(row, 1, row, 6)
    row += 1

    const headers = ['№', 'Найменування', 'Од.', 'К-сть', 'Ціна', 'Сума']
    headers.forEach((h, i) => {
      const cell = sheet.getCell(row, i + 1)
      cell.value = h
      styleTableHeader(cell, palette)
    })
    sheet.getRow(row).height = 25
    row += 1

    let n = 1
    section.items?.forEach((item) => {
      const qty = item.quantity || 0
      const price = item.priceClient || 0

      sheet.getCell(row, 1).value = n++
      styleCell(sheet.getCell(row, 1), { align: 'center' })

      sheet.getCell(row, 2).value = item.name || '—'
      styleCell(sheet.getCell(row, 2), { align: 'left' })

      sheet.getCell(row, 3).value = item.unit || ''
      styleCell(sheet.getCell(row, 3), { align: 'center' })

      sheet.getCell(row, 4).value = qty
      styleCell(sheet.getCell(row, 4), { align: 'center', numFmt: MONEY_FORMAT })

      sheet.getCell(row, 5).value = price
      styleCell(sheet.getCell(row, 5), { align: 'right', numFmt: MONEY_FORMAT })

      sheet.getCell(row, 6).value = qty * price
      styleCell(sheet.getCell(row, 6), { align: 'right', numFmt: MONEY_FORMAT, bold: true })

      row += 1

      item.materials?.forEach((mat) => {
        const isCustomer = mat.isCustomerSupplied
        const mq = isCustomer ? mat.quantity || 0 : roundUp(mat.quantity || 0)
        const mp = mat.priceClient || 0

        sheet.getCell(row, 1).value = ''
        styleCell(sheet.getCell(row, 1), { align: 'center' })

        sheet.getCell(row, 2).value = '  • ' + (mat.name || '')
        sheet.getCell(row, 2).font = { name: 'Calibri', size: 9, italic: true, color: { argb: 'FF555555' } }
        sheet.getCell(row, 2).alignment = { vertical: 'middle', horizontal: 'left', wrapText: true }
        sheet.getCell(row, 2).border = BORDER_THIN

        sheet.getCell(row, 3).value = mat.unit || ''
        styleCell(sheet.getCell(row, 3), { align: 'center' })

        sheet.getCell(row, 4).value = mq
        styleCell(sheet.getCell(row, 4), { align: 'center', numFmt: INT_FORMAT })

        if (isCustomer) {
          sheet.getCell(row, 5).value = 'Замовник'
          const c = sheet.getCell(row, 5)
          c.font = { name: 'Calibri', size: 8, italic: true, color: { argb: 'FF333333' } }
          c.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true }
          c.border = BORDER_THIN

          sheet.getCell(row, 6).value = '—'
          styleCell(sheet.getCell(row, 6), { align: 'center' })
        } else {
          sheet.getCell(row, 5).value = mp
          styleCell(sheet.getCell(row, 5), { align: 'right', numFmt: MONEY_FORMAT })

          sheet.getCell(row, 6).value = mq * mp
          styleCell(sheet.getCell(row, 6), { align: 'right', numFmt: MONEY_FORMAT })
        }

        row += 1
      })
    })

    let sectionTotal = 0
    section.items?.forEach((item) => {
      sectionTotal += (item.quantity || 0) * (item.priceClient || 0)
      item.materials?.forEach((mat) => {
        if (mat.isCustomerSupplied) return
        sectionTotal += roundUp(mat.quantity || 0) * (mat.priceClient || 0)
      })
    })

    sheet.mergeCells(row, 1, row, 5)
    const totalLabelCell = sheet.getCell(row, 5)
    totalLabelCell.value = 'Всього по розділу:'
    styleTotalCell(totalLabelCell, 'right')

    const totalValueCell = sheet.getCell(row, 6)
    totalValueCell.value = sectionTotal
    styleTotalCell(totalValueCell, 'right')
    totalValueCell.numFmt = MONEY_FORMAT

    row += 2
  })

  const summaryData = [
    ['Роботи:', totals.workKoshtorys],
    ['Матеріали:', totals.matKoshtorys],
  ]

  totals.limits.forEach((lim) => {
    if (lim.amount > 0) {
      summaryData.push([`${lim.name} (${lim.percent}% ${baseLabel(lim.base)}):`, lim.amount])
    }
  })

  if (totals.limitsTotal > 0) {
    summaryData.push(['Проміжний підсумок:', totals.subTotal])
  }

  if (totals.vat > 0) {
    summaryData.push([`ПДВ ${vedomost.vatPercent}% (${baseLabel(vedomost.vatBase)}):`, totals.vat])
  }

  summaryData.forEach(([label, value]) => {
    sheet.mergeCells(row, 1, row, 5)
    const labelCell = sheet.getCell(row, 5)
    labelCell.value = label
    labelCell.font = { name: 'Calibri', size: 10, bold: true, color: { argb: 'FF000000' } }
    labelCell.alignment = { vertical: 'middle', horizontal: 'right' }

    const valueCell = sheet.getCell(row, 6)
    valueCell.value = value
    valueCell.font = { name: 'Calibri', size: 10, bold: true, color: { argb: 'FF000000' } }
    valueCell.alignment = { vertical: 'middle', horizontal: 'right' }
    valueCell.numFmt = MONEY_FORMAT

    row += 1
  })

  row += 1
  sheet.mergeCells(row, 1, row, 5)
  const grandLabel = sheet.getCell(row, 5)
  grandLabel.value = 'ВСЬОГО:'
  styleGrandTotalCell(grandLabel, 'right')

  const grandValue = sheet.getCell(row, 6)
  grandValue.value = totals.grandTotal
  styleGrandTotalCell(grandValue, 'right')
  grandValue.numFmt = MONEY_FORMAT

  row += 2

  if (vedomost.notes && vedomost.notes.trim()) {
    const notesTitle = sheet.getCell(row, 1)
    notesTitle.value = 'Примітки:'
    notesTitle.font = { name: 'Calibri', size: 10, bold: true, color: { argb: 'FF000000' } }
    row += 1

    const lines = vedomost.notes.split('\n').filter((l) => l.trim())
    lines.forEach((line, i) => {
      const cell = sheet.getCell(row, 1)
      cell.value = `${i + 1}. ${line.trim()}`
      cell.font = { name: 'Calibri', size: 9, color: { argb: 'FF333333' } }
      cell.alignment = { vertical: 'middle', horizontal: 'left', wrapText: true }
      sheet.mergeCells(row, 1, row, 6)
      sheet.getRow(row).height = 20
      row += 1
    })
    row += 1
  }

  row += 2
  sheet.getCell(row, 1).value = 'Виконавець'
  sheet.getCell(row, 1).font = { name: 'Calibri', size: 10, color: { argb: 'FF000000' } }
  sheet.mergeCells(row, 1, row, 3)

  sheet.getCell(row, 5).value = 'Замовник'
  sheet.getCell(row, 5).font = { name: 'Calibri', size: 10, color: { argb: 'FF000000' } }
  sheet.mergeCells(row, 5, row, 6)

  row += 2
  sheet.mergeCells(row, 1, row, 3)
  sheet.getCell(row, 1).value = '__________________'
  sheet.mergeCells(row, 5, row, 6)
  sheet.getCell(row, 5).value = '__________________'
}

// ============ 9-ТИ ГРАФКА ============

function build9GraphExcel(workbook, sheet, vedomost, companySettings, totals, palette) {
  sheet.columns = [
    { width: 6 },
    { width: 40 },
    { width: 10 },
    { width: 12 },
    { width: 18 },
    { width: 18 },
    { width: 18 },
    { width: 18 },
    { width: 18 },
  ]

  let row = buildHeaderRows(workbook, sheet, vedomost, companySettings, 'КОШТОРИС', 9)

  const subCell = sheet.getCell(row, 1)
  subCell.value = 'Роботи та матеріали'
  subCell.font = { name: 'Calibri', size: 13, bold: true, color: { argb: 'FF000000' } }
  sheet.mergeCells(row, 1, row, 9)
  row += 2

  vedomost.sections?.forEach((section, idx) => {
    const sectionCell = sheet.getCell(row, 1)
    sectionCell.value = `${idx + 1}. ${section.name || 'Без назви'}`
    sectionCell.font = { name: 'Calibri', size: 11, bold: true, color: { argb: 'FF000000' } }
    sheet.mergeCells(row, 1, row, 9)
    row += 1

    const headerRow1 = row
    const headerRow2 = row + 1

    sheet.mergeCells(headerRow1, 1, headerRow2, 1)
    sheet.getCell(headerRow1, 1).value = '№'
    styleTableHeader(sheet.getCell(headerRow1, 1), palette)

    sheet.mergeCells(headerRow1, 2, headerRow2, 2)
    sheet.getCell(headerRow1, 2).value = 'Найменування робіт, матеріалів, витрат'
    styleTableHeader(sheet.getCell(headerRow1, 2), palette)

    sheet.mergeCells(headerRow1, 3, headerRow2, 3)
    sheet.getCell(headerRow1, 3).value = 'Од. вим.'
    styleTableHeader(sheet.getCell(headerRow1, 3), palette)

    sheet.mergeCells(headerRow1, 4, headerRow2, 4)
    sheet.getCell(headerRow1, 4).value = 'К-сть'
    styleTableHeader(sheet.getCell(headerRow1, 4), palette)

    sheet.mergeCells(headerRow1, 5, headerRow1, 6)
    sheet.getCell(headerRow1, 5).value = 'Ціна одиниці, грн.'
    styleTableHeader(sheet.getCell(headerRow1, 5), palette)

    sheet.mergeCells(headerRow1, 7, headerRow1, 9)
    sheet.getCell(headerRow1, 7).value = 'Вартість, грн.'
    styleTableHeader(sheet.getCell(headerRow1, 7), palette)

    sheet.getCell(headerRow2, 5).value = 'Роботи'
    styleTableHeader(sheet.getCell(headerRow2, 5), palette)
    sheet.getCell(headerRow2, 6).value = 'Матеріали'
    styleTableHeader(sheet.getCell(headerRow2, 6), palette)
    sheet.getCell(headerRow2, 7).value = 'Роботи'
    styleTableHeader(sheet.getCell(headerRow2, 7), palette)
    sheet.getCell(headerRow2, 8).value = 'Матеріали'
    styleTableHeader(sheet.getCell(headerRow2, 8), palette)
    sheet.getCell(headerRow2, 9).value = 'Всього'
    styleTableHeader(sheet.getCell(headerRow2, 9), palette)

    sheet.getRow(headerRow1).height = 22
    sheet.getRow(headerRow2).height = 22
    row += 2

    let n = 1
    let sectionWorkTotal = 0
    let sectionMatTotal = 0

    section.items?.forEach((item) => {
      const qty = item.quantity || 0
      const pw = item.priceWorker || 0
      const pc = item.priceClient || 0
      const workSum = qty * pc
      sectionWorkTotal += workSum

      sheet.getCell(row, 1).value = n++
      styleCell(sheet.getCell(row, 1), { align: 'center' })

      sheet.getCell(row, 2).value = item.name || '—'
      styleCell(sheet.getCell(row, 2), { align: 'left' })

      sheet.getCell(row, 3).value = item.unit || ''
      styleCell(sheet.getCell(row, 3), { align: 'center' })

      sheet.getCell(row, 4).value = qty
      styleCell(sheet.getCell(row, 4), { align: 'center', numFmt: MONEY_FORMAT })

      sheet.getCell(row, 5).value = pw
      styleCell(sheet.getCell(row, 5), { align: 'right', numFmt: MONEY_FORMAT })

      sheet.getCell(row, 6).value = ''
      styleCell(sheet.getCell(row, 6), { align: 'right' })

      sheet.getCell(row, 7).value = workSum
      styleCell(sheet.getCell(row, 7), { align: 'right', numFmt: MONEY_FORMAT })

      sheet.getCell(row, 8).value = ''
      styleCell(sheet.getCell(row, 8), { align: 'right' })

      sheet.getCell(row, 9).value = workSum
      styleCell(sheet.getCell(row, 9), { align: 'right', numFmt: MONEY_FORMAT, bold: true })

      row += 1

      item.materials?.forEach((mat) => {
        const isCustomer = mat.isCustomerSupplied
        const mq = isCustomer ? mat.quantity || 0 : roundUp(mat.quantity || 0)
        const mc = mat.priceClient || 0
        const matSum = isCustomer ? 0 : mq * mc
        if (!isCustomer) sectionMatTotal += matSum

        sheet.getCell(row, 1).value = ''
        styleCell(sheet.getCell(row, 1), { align: 'center' })

        sheet.getCell(row, 2).value = '  • ' + (mat.name || '')
        sheet.getCell(row, 2).font = { name: 'Calibri', size: 9, italic: true, color: { argb: 'FF555555' } }
        sheet.getCell(row, 2).alignment = { vertical: 'middle', horizontal: 'left', wrapText: true }
        sheet.getCell(row, 2).border = BORDER_THIN

        sheet.getCell(row, 3).value = mat.unit || ''
        styleCell(sheet.getCell(row, 3), { align: 'center' })

        sheet.getCell(row, 4).value = mq
        styleCell(sheet.getCell(row, 4), { align: 'center', numFmt: INT_FORMAT })

        sheet.getCell(row, 5).value = ''
        styleCell(sheet.getCell(row, 5), { align: 'right' })

        if (isCustomer) {
          sheet.getCell(row, 6).value = 'Замовник'
          const c = sheet.getCell(row, 6)
          c.font = { name: 'Calibri', size: 8, italic: true, color: { argb: 'FF333333' } }
          c.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true }
          c.border = BORDER_THIN

          sheet.getCell(row, 7).value = ''
          styleCell(sheet.getCell(row, 7), { align: 'right' })

          sheet.getCell(row, 8).value = '—'
          styleCell(sheet.getCell(row, 8), { align: 'center' })

          sheet.getCell(row, 9).value = '—'
          styleCell(sheet.getCell(row, 9), { align: 'center' })
        } else {
          sheet.getCell(row, 6).value = mc
          styleCell(sheet.getCell(row, 6), { align: 'right', numFmt: MONEY_FORMAT })

          sheet.getCell(row, 7).value = ''
          styleCell(sheet.getCell(row, 7), { align: 'right' })

          sheet.getCell(row, 8).value = matSum
          styleCell(sheet.getCell(row, 8), { align: 'right', numFmt: MONEY_FORMAT })

          sheet.getCell(row, 9).value = matSum
          styleCell(sheet.getCell(row, 9), { align: 'right', numFmt: MONEY_FORMAT })
        }

        row += 1
      })
    })

    sheet.mergeCells(row, 1, row, 4)
    const sectionLabelCell = sheet.getCell(row, 1)
    sectionLabelCell.value = 'Всього по розділу:'
    styleTotalCell(sectionLabelCell, 'right')

    sheet.getCell(row, 5).value = ''
    styleTotalCell(sheet.getCell(row, 5), 'right')
    sheet.getCell(row, 6).value = ''
    styleTotalCell(sheet.getCell(row, 6), 'right')

    sheet.getCell(row, 7).value = sectionWorkTotal
    styleTotalCell(sheet.getCell(row, 7), 'right')
    sheet.getCell(row, 7).numFmt = MONEY_FORMAT

    sheet.getCell(row, 8).value = sectionMatTotal
    styleTotalCell(sheet.getCell(row, 8), 'right')
    sheet.getCell(row, 8).numFmt = MONEY_FORMAT

    sheet.getCell(row, 9).value = sectionWorkTotal + sectionMatTotal
    styleTotalCell(sheet.getCell(row, 9), 'right')
    sheet.getCell(row, 9).numFmt = MONEY_FORMAT

    row += 2
  })

  const summaryData = [
    ['Разом по роботах:', totals.workKoshtorys],
    ['Разом по матеріалах:', totals.matKoshtorys],
  ]

  totals.limits.forEach((lim) => {
    if (lim.amount > 0) {
      summaryData.push([`${lim.name} (${lim.percent}% ${baseLabel(lim.base)}):`, lim.amount])
    }
  })

  if (totals.limitsTotal > 0) {
    summaryData.push(['Проміжний підсумок:', totals.subTotal])
  }

  if (totals.vat > 0) {
    summaryData.push([`ПДВ ${vedomost.vatPercent}% (${baseLabel(vedomost.vatBase)}):`, totals.vat])
  }

  summaryData.forEach(([label, value]) => {
    sheet.mergeCells(row, 1, row, 8)
    const labelCell = sheet.getCell(row, 8)
    labelCell.value = label
    labelCell.font = { name: 'Calibri', size: 10, bold: true, color: { argb: 'FF000000' } }
    labelCell.alignment = { vertical: 'middle', horizontal: 'right' }

    const valueCell = sheet.getCell(row, 9)
    valueCell.value = value
    valueCell.font = { name: 'Calibri', size: 10, bold: true, color: { argb: 'FF000000' } }
    valueCell.alignment = { vertical: 'middle', horizontal: 'right' }
    valueCell.numFmt = MONEY_FORMAT

    row += 1
  })

  row += 1
  sheet.mergeCells(row, 1, row, 8)
  const grandLabel = sheet.getCell(row, 8)
  grandLabel.value = 'ВСЬОГО:'
  styleGrandTotalCell(grandLabel, 'right')

  const grandValue = sheet.getCell(row, 9)
  grandValue.value = totals.grandTotal
  styleGrandTotalCell(grandValue, 'right')
  grandValue.numFmt = MONEY_FORMAT

  row += 2

  if (vedomost.notes && vedomost.notes.trim()) {
    const notesTitle = sheet.getCell(row, 1)
    notesTitle.value = 'Примітки:'
    notesTitle.font = { name: 'Calibri', size: 10, bold: true, color: { argb: 'FF000000' } }
    row += 1

    const lines = vedomost.notes.split('\n').filter((l) => l.trim())
    lines.forEach((line, i) => {
      const cell = sheet.getCell(row, 1)
      cell.value = `${i + 1}. ${line.trim()}`
      cell.font = { name: 'Calibri', size: 9, color: { argb: 'FF333333' } }
      cell.alignment = { vertical: 'middle', horizontal: 'left', wrapText: true }
      sheet.mergeCells(row, 1, row, 9)
      sheet.getRow(row).height = 20
      row += 1
    })
    row += 1
  }

  row += 2
  sheet.mergeCells(row, 1, row, 4)
  sheet.getCell(row, 1).value = 'Виконавець'
  sheet.getCell(row, 1).font = { name: 'Calibri', size: 10, color: { argb: 'FF000000' } }

  sheet.mergeCells(row, 6, row, 9)
  sheet.getCell(row, 6).value = 'Замовник'
  sheet.getCell(row, 6).font = { name: 'Calibri', size: 10, color: { argb: 'FF000000' } }

  row += 2
  sheet.mergeCells(row, 1, row, 4)
  sheet.getCell(row, 1).value = '__________________'
  sheet.mergeCells(row, 6, row, 9)
  sheet.getCell(row, 6).value = '__________________'
}

// ============ НАРЯД ============

function buildNaryadExcel(workbook, sheet, vedomost, companySettings, totals, palette) {
  sheet.columns = [
    { width: 6 },
    { width: 50 },
    { width: 10 },
    { width: 12 },
    { width: 18 },
    { width: 18 },
  ]

  let row = buildHeaderRows(workbook, sheet, vedomost, companySettings, 'НАРЯД НА РОБОТИ', 6)

  const subCell = sheet.getCell(row, 1)
  subCell.value = 'Роботи'
  subCell.font = { name: 'Calibri', size: 13, bold: true, color: { argb: 'FF000000' } }
  sheet.mergeCells(row, 1, row, 6)
  row += 2

  vedomost.sections?.forEach((section, idx) => {
    const sectionCell = sheet.getCell(row, 1)
    sectionCell.value = `${idx + 1}. ${section.name || 'Без назви'}`
    sectionCell.font = { name: 'Calibri', size: 11, bold: true, color: { argb: 'FF000000' } }
    sheet.mergeCells(row, 1, row, 6)
    row += 1

    const headers = ['№', 'Найменування робіт', 'Од.', 'К-сть', 'Ціна (наряд)', 'Сума']
    headers.forEach((h, i) => {
      const cell = sheet.getCell(row, i + 1)
      cell.value = h
      styleTableHeader(cell, palette)
    })
    sheet.getRow(row).height = 25
    row += 1

    let n = 1
    let sectionTotal = 0
    section.items?.forEach((item) => {
      const qty = item.quantity || 0
      const price = item.priceWorker || 0
      sectionTotal += qty * price

      sheet.getCell(row, 1).value = n++
      styleCell(sheet.getCell(row, 1), { align: 'center' })

      sheet.getCell(row, 2).value = item.name || '—'
      styleCell(sheet.getCell(row, 2), { align: 'left' })

      sheet.getCell(row, 3).value = item.unit || ''
      styleCell(sheet.getCell(row, 3), { align: 'center' })

      sheet.getCell(row, 4).value = qty
      styleCell(sheet.getCell(row, 4), { align: 'center', numFmt: MONEY_FORMAT })

      sheet.getCell(row, 5).value = price
      styleCell(sheet.getCell(row, 5), { align: 'right', numFmt: MONEY_FORMAT })

      sheet.getCell(row, 6).value = qty * price
      styleCell(sheet.getCell(row, 6), { align: 'right', numFmt: MONEY_FORMAT, bold: true })

      row += 1
    })

    sheet.mergeCells(row, 1, row, 5)
    const totalLabel = sheet.getCell(row, 5)
    totalLabel.value = 'Всього по розділу:'
    styleTotalCell(totalLabel, 'right')

    const totalValue = sheet.getCell(row, 6)
    totalValue.value = sectionTotal
    styleTotalCell(totalValue, 'right')
    totalValue.numFmt = MONEY_FORMAT

    row += 2
  })

  sheet.mergeCells(row, 1, row, 5)
  const grandLabel = sheet.getCell(row, 5)
  grandLabel.value = 'ВСЬОГО ДО ВИПЛАТИ:'
  grandLabel.font = { name: 'Calibri', size: 12, bold: true, color: { argb: 'FF000000' } }
  grandLabel.alignment = { vertical: 'middle', horizontal: 'right' }

  const grandValue = sheet.getCell(row, 6)
  grandValue.value = totals.workNaryad
  styleGrandTotalCell(grandValue, 'right')
  grandValue.numFmt = MONEY_FORMAT

  row += 3

  sheet.mergeCells(row, 1, row, 3)
  sheet.getCell(row, 1).value = 'Виконавець'
  sheet.getCell(row, 1).font = { name: 'Calibri', size: 10, color: { argb: 'FF000000' } }

  sheet.mergeCells(row, 4, row, 6)
  sheet.getCell(row, 4).value = 'Бригадир / робітник'
  sheet.getCell(row, 4).font = { name: 'Calibri', size: 10, color: { argb: 'FF000000' } }

  row += 2
  sheet.mergeCells(row, 1, row, 3)
  sheet.getCell(row, 1).value = '__________________'
  sheet.mergeCells(row, 4, row, 6)
  sheet.getCell(row, 4).value = '__________________'
}

// ============ ВЕДОМОСТЬ МАТЕРИАЛОВ ============

function buildVedomistMaterialsExcel(workbook, sheet, vedomost, companySettings, palette) {
  sheet.columns = [
    { width: 6 },
    { width: 50 },
    { width: 10 },
    { width: 12 },
    { width: 18 },
    { width: 18 },
  ]

  let row = buildHeaderRows(workbook, sheet, vedomost, companySettings, 'ВЕДОМІСТЬ МАТЕРІАЛІВ', 6)

  const subCell = sheet.getCell(row, 1)
  subCell.value = 'Перелік матеріалів'
  subCell.font = { name: 'Calibri', size: 13, bold: true, color: { argb: 'FF000000' } }
  sheet.mergeCells(row, 1, row, 6)
  row += 2

  const headers = ['№', 'Найменування матеріалу', 'Од.', 'К-сть', 'Ціна', 'Сума']
  headers.forEach((h, i) => {
    const cell = sheet.getCell(row, i + 1)
    cell.value = h
    styleTableHeader(cell, palette)
  })
  sheet.getRow(row).height = 25
  row += 1

  const allMaterials = []
  vedomost.sections?.forEach((section) => {
    section.items?.forEach((item) => {
      item.materials?.forEach((mat) => {
        if (mat.isCustomerSupplied) return
        allMaterials.push(mat)
      })
    })
  })

  let total = 0
  allMaterials.forEach((mat, i) => {
    const qty = roundUp(mat.quantity || 0)
    const price = mat.pricePurchase || 0
    total += qty * price

    sheet.getCell(row, 1).value = i + 1
    styleCell(sheet.getCell(row, 1), { align: 'center' })

    sheet.getCell(row, 2).value = mat.name || '—'
    styleCell(sheet.getCell(row, 2), { align: 'left' })

    sheet.getCell(row, 3).value = mat.unit || ''
    styleCell(sheet.getCell(row, 3), { align: 'center' })

    sheet.getCell(row, 4).value = qty
    styleCell(sheet.getCell(row, 4), { align: 'center', numFmt: INT_FORMAT })

    sheet.getCell(row, 5).value = price
    styleCell(sheet.getCell(row, 5), { align: 'right', numFmt: MONEY_FORMAT })

    sheet.getCell(row, 6).value = qty * price
    styleCell(sheet.getCell(row, 6), { align: 'right', numFmt: MONEY_FORMAT, bold: true })

    row += 1
  })

  row += 1
  sheet.mergeCells(row, 1, row, 5)
  const grandLabel = sheet.getCell(row, 5)
  grandLabel.value = 'ВСЬОГО:'
  grandLabel.font = { name: 'Calibri', size: 12, bold: true, color: { argb: 'FF000000' } }
  grandLabel.alignment = { vertical: 'middle', horizontal: 'right' }

  const grandValue = sheet.getCell(row, 6)
  grandValue.value = total
  styleGrandTotalCell(grandValue, 'right')
  grandValue.numFmt = MONEY_FORMAT
}

// ============ РОУТ ============

router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params
    const { type, color } = req.query

    const vedomost = await prisma.vedomost.findUnique({
      where: { id },
      include: {
        client: true,
        limits: { orderBy: { order: 'asc' } },
        sections: {
          orderBy: { order: 'asc' },
          include: {
            items: {
              include: { materials: true },
            },
          },
        },
      },
    })

    if (!vedomost) {
      return res.status(404).json({ error: 'Відомість не знайдена' })
    }

    let companySettings = null
    if (vedomost.userId) {
      companySettings = await prisma.companySettings.findUnique({
        where: { userId: vedomost.userId },
      })
    }

    const totals = calcTotals(vedomost)
    const palette = getPalette(color)

    const workbook = new ExcelJS.Workbook()
    workbook.creator = 'СметаPRO'
    workbook.created = new Date()

    const sheet = workbook.addWorksheet('Документ', {
      pageSetup: {
        orientation: type === '9graph' ? 'landscape' : 'portrait',
        fitToPage: true,
        fitToWidth: 1,
        fitToHeight: 0,
        paperSize: 9,
        margins: {
          left: 0.5,
          right: 0.5,
          top: 0.5,
          bottom: 0.5,
          header: 0.3,
          footer: 0.3,
        },
      },
    })

    let filename

    switch (type) {
      case '9graph':
        build9GraphExcel(workbook, sheet, vedomost, companySettings, totals, palette)
        filename = `koshtorys-9graph-${vedomost.number || id}.xlsx`
        break
      case 'naryad':
        buildNaryadExcel(workbook, sheet, vedomost, companySettings, totals, palette)
        filename = `naryad-${vedomost.number || id}.xlsx`
        break
      case 'vedomist':
        buildVedomistMaterialsExcel(workbook, sheet, vedomost, companySettings, palette)
        filename = `vedomist-materialiv-${vedomost.number || id}.xlsx`
        break
      case 'koshtorys':
      case '6graph':
      default:
        buildKoshtorysExcel(workbook, sheet, vedomost, companySettings, totals, palette)
        filename = `koshtorys-6graph-${vedomost.number || id}.xlsx`
        break
    }

    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    )
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)

    await workbook.xlsx.write(res)
    res.end()
  } catch (error) {
    console.error('Помилка генерації Excel:', error)
    res.status(500).json({ error: error.message })
  }
})

module.exports = router