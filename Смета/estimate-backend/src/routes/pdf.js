const express = require('express')
const router = express.Router()
const path = require('path')
const fs = require('fs')
const prisma = require('../prisma')
const PdfPrinter = require('pdfmake/src/printer')

const pdfFonts = require('pdfmake/build/vfs_fonts')

const fonts = {
  Roboto: {
    normal: Buffer.from(pdfFonts.pdfMake.vfs['Roboto-Regular.ttf'], 'base64'),
    bold: Buffer.from(pdfFonts.pdfMake.vfs['Roboto-Medium.ttf'], 'base64'),
    italics: Buffer.from(pdfFonts.pdfMake.vfs['Roboto-Italic.ttf'], 'base64'),
    bolditalics: Buffer.from(pdfFonts.pdfMake.vfs['Roboto-MediumItalic.ttf'], 'base64'),
  },
}

const printer = new PdfPrinter(fonts)

// ============ ПАЛИТРЫ ЦВЕТОВ ============

const COLOR_PALETTES = {
  violet: { bg: '#7C3AED', text: '#FFFFFF' },
  blue: { bg: '#2563EB', text: '#FFFFFF' },
  emerald: { bg: '#059669', text: '#FFFFFF' },
  slate: { bg: '#1E293B', text: '#FFFFFF' },
  amber: { bg: '#D97706', text: '#FFFFFF' },
  yellow: { bg: '#EAB308', text: '#000000' },
  none: { bg: null, text: '#000000' },
}

function getPalette(colorName) {
  return COLOR_PALETTES[colorName] || COLOR_PALETTES.none
}

// ============ УТИЛИТЫ ============

function money(value) {
  const num = parseFloat(value) || 0
  return (
    num.toLocaleString('uk-UA', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }) + ' грн'
  )
}

function roundUp(value) {
  const num = parseFloat(value) || 0
  return Math.ceil(num)
}

function number(value, decimals = 2) {
  const num = parseFloat(value) || 0
  if (decimals === 0) {
    return roundUp(num).toLocaleString('uk-UA')
  }
  return num.toLocaleString('uk-UA', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })
}

function dateUk(d) {
  const date = new Date(d)
  return date.toLocaleDateString('uk-UA', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  })
}

function baseLabel(base) {
  if (base === 'works') return 'від робіт'
  if (base === 'materials') return 'від матеріалів'
  if (base === 'both') return 'від робіт і матеріалів'
  return ''
}

// ============ РАСЧЁТ ============

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

// ============ ЛОГОТИП ============

function getLogo(companySettings) {
  if (!companySettings?.logoUrl) return null
  try {
    const logoPath = path.join(__dirname, '../..', companySettings.logoUrl)
    if (fs.existsSync(logoPath)) {
      const ext = path.extname(logoPath).toLowerCase().replace('.', '')
      const base64 = fs.readFileSync(logoPath).toString('base64')
      return `data:image/${ext === 'jpg' ? 'jpeg' : ext};base64,${base64}`
    }
  } catch (err) {
    console.error('Помилка читання логотипу:', err)
  }
  return null
}

// ============ ШАПКА ДОКУМЕНТА ============

function buildHeader(vedomost, companySettings, docTitle, isLandscape = false) {
  const logo = getLogo(companySettings)
  const header = []

  // Ширина страницы: портрет = 515pt, ландшафт = 842pt
  const pageWidth = isLandscape ? 762 : 515

  const leftColumn = logo
    ? { image: logo, width: 60, fit: [60, 60] }
    : { text: '', width: 60 }

  const rightColumn = {
    width: '*',
    stack: [],
    alignment: 'right',
  }

  if (companySettings?.companyName) {
    rightColumn.stack.push({
      text: companySettings.companyName,
      bold: true,
      fontSize: 11,
      margin: [0, 0, 0, 1],
    })
  }
  if (companySettings?.phone) {
    rightColumn.stack.push({ text: companySettings.phone, fontSize: 10, color: '#333' })
  }
  if (companySettings?.website) {
    rightColumn.stack.push({ text: companySettings.website, fontSize: 10, color: '#333' })
  }
  if (companySettings?.email) {
    rightColumn.stack.push({ text: companySettings.email, fontSize: 10, color: '#333' })
  }
  if (companySettings?.address) {
    rightColumn.stack.push({ text: companySettings.address, fontSize: 10, color: '#333' })
  }

  header.push({
    columns: [leftColumn, rightColumn],
    margin: [0, 0, 0, 12],
  })

  // Линия-разделитель на всю ширину страницы
  header.push({
    canvas: [{ type: 'line', x1: 0, y1: 0, x2: pageWidth, y2: 0, lineWidth: 1, lineColor: '#999' }],
    margin: [0, 0, 0, 12],
  })

  header.push({
    columns: [
      {
        width: '*',
        stack: [
          { text: docTitle, style: 'docTitle' },
          { text: '№ ' + (vedomost.number || '—'), fontSize: 10, color: '#444', margin: [0, 2, 0, 0] },
        ],
      },
      {
        width: 'auto',
        stack: [
          { text: 'Дата: ' + dateUk(vedomost.createdAt), alignment: 'right', fontSize: 10 },
        ],
      },
    ],
    margin: [0, 0, 0, 12],
  })

  // Информация о ведомости — единым блоком
  const infoLines = []
  infoLines.push({
    text: 'Назва: ' + (vedomost.title || '—'),
    fontSize: 11,
    margin: [0, 0, 0, 2],
  })
  infoLines.push({
    text: "Об'єкт: " + (vedomost.object || '—'),
    fontSize: 11,
    margin: [0, 0, 0, 2],
  })
  infoLines.push({
    text: 'Замовник: ' + (vedomost.client?.name || '—'),
    fontSize: 11,
    margin: [0, 0, 0, 16],
  })

  header.push(...infoLines)

  return header
}

// ============ БЛОК ЛИМИТОВ + НДС ============

function buildLimitsBlock(vedomost, totals) {
  const rows = []

  totals.limits.forEach((lim) => {
    if (lim.amount > 0) {
      rows.push([
        {
          text: `${lim.name} (${lim.percent}% ${baseLabel(lim.base)})`,
          fontSize: 10,
          border: [false, false, false, false],
        },
        {
          text: money(lim.amount),
          fontSize: 10,
          alignment: 'right',
          border: [false, false, false, false],
        },
      ])
    }
  })

  const block = []

  if (rows.length > 0) {
    block.push({ text: 'Лімітовані витрати:', bold: true, fontSize: 11, margin: [0, 12, 0, 6] })
    block.push({
      table: { widths: ['*', 120], body: rows },
      layout: 'noBorders',
    })
  }

  if (vedomost.vatPercent > 0) {
    block.push({
      margin: [0, 8, 0, 0],
      table: {
        widths: ['*', 120],
        body: [
          [
            {
              text: `ПДВ ${vedomost.vatPercent}% (${baseLabel(vedomost.vatBase)})`,
              fontSize: 10,
              border: [false, false, false, false],
            },
            {
              text: money(totals.vat),
              fontSize: 10,
              alignment: 'right',
              border: [false, false, false, false],
            },
          ],
        ],
      },
      layout: 'noBorders',
    })
  }

  return block
}

// ============ ПОДПИСИ + ПРИМЕЧАНИЯ ============

function buildFooter(vedomost) {
  const footer = []

  if (vedomost.notes && vedomost.notes.trim()) {
    footer.push({ text: 'Примітки:', bold: true, fontSize: 10, margin: [0, 20, 0, 4] })
    const lines = vedomost.notes.split('\n').filter((l) => l.trim())
    lines.forEach((line, i) => {
      footer.push({
        text: `${i + 1}. ${line.trim()}`,
        fontSize: 9,
        color: '#333',
        margin: [0, 1, 0, 1],
      })
    })
  }

  footer.push({
    margin: [0, 40, 0, 0],
    columns: [
      { width: '*', stack: [{ text: 'Виконавець', fontSize: 10 }, { text: '__________________', margin: [0, 30, 0, 0] }] },
      { width: '*', stack: [{ text: 'Замовник', fontSize: 10 }, { text: '__________________', margin: [0, 30, 0, 0] }] },
    ],
  })

  return footer
}

function buildStyles() {
  return {
    docTitle: { fontSize: 18, bold: true },
    subtitle: { fontSize: 10, color: '#666' },
    h2: { fontSize: 14, bold: true },
  }
}

// ============ 6-ТИ ГРАФКА ============

function buildKoshtorys(vedomost, companySettings, totals, palette) {
  const content = [
    ...buildHeader(vedomost, companySettings, 'КОШТОРИС', false),
    { text: 'Роботи та матеріали', style: 'h2', margin: [0, 0, 0, 8] },
  ]

  vedomost.sections?.forEach((section, idx) => {
    content.push({
      text: `${idx + 1}. ${section.name || 'Без назви'}`,
      bold: true,
      fontSize: 12,
      margin: [0, 12, 0, 6],
    })

    const headerFill = palette.bg || undefined
    const headerText = palette.text

    const body = [
      [
        { text: '№', bold: true, fontSize: 9, alignment: 'center', verticalAlignment: 'middle', fillColor: headerFill, color: headerText },
        { text: 'Найменування', bold: true, fontSize: 9, verticalAlignment: 'middle', fillColor: headerFill, color: headerText },
        { text: 'Од.', bold: true, fontSize: 9, alignment: 'center', verticalAlignment: 'middle', fillColor: headerFill, color: headerText },
        { text: 'К-сть', bold: true, fontSize: 9, alignment: 'center', verticalAlignment: 'middle', fillColor: headerFill, color: headerText },
        { text: 'Ціна', bold: true, fontSize: 9, alignment: 'center', verticalAlignment: 'middle', fillColor: headerFill, color: headerText },
        { text: 'Сума', bold: true, fontSize: 9, alignment: 'center', verticalAlignment: 'middle', fillColor: headerFill, color: headerText },
      ],
    ]

    let n = 1
    section.items?.forEach((item) => {
      const qty = item.quantity || 0
      const price = item.priceClient || 0
      body.push([
        { text: String(n++), fontSize: 9, alignment: 'center', verticalAlignment: 'middle' },
        { text: item.name || '—', fontSize: 9, verticalAlignment: 'middle' },
        { text: item.unit || '', fontSize: 9, alignment: 'center', verticalAlignment: 'middle' },
        { text: number(qty), fontSize: 9, alignment: 'center', verticalAlignment: 'middle' },
        { text: money(price), fontSize: 9, alignment: 'center', verticalAlignment: 'middle' },
        { text: money(qty * price), fontSize: 9, alignment: 'center', verticalAlignment: 'middle' },
      ])

      item.materials?.forEach((mat) => {
        const isCustomer = mat.isCustomerSupplied
        const mq = isCustomer ? mat.quantity || 0 : roundUp(mat.quantity || 0)
        const mp = mat.priceClient || 0

        body.push([
          { text: '', fontSize: 8, verticalAlignment: 'middle' },
          { text: '  • ' + (mat.name || ''), fontSize: 8, color: '#555', verticalAlignment: 'middle' },
          { text: mat.unit || '', fontSize: 8, alignment: 'center', color: '#555', verticalAlignment: 'middle' },
          { text: number(mq, 0), fontSize: 8, alignment: 'center', color: '#555', verticalAlignment: 'middle' },
          {
            text: isCustomer ? 'Замовник' : money(mp),
            fontSize: 8,
            alignment: 'center',
            color: isCustomer ? '#059669' : '#555',
            italics: isCustomer,
            verticalAlignment: 'middle',
          },
          {
            text: isCustomer ? '—' : money(mq * mp),
            fontSize: 8,
            alignment: 'center',
            color: '#555',
            verticalAlignment: 'middle',
          },
        ])
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

    body.push([
      { text: '', colSpan: 5, border: [false, false, false, false] },
      {}, {}, {},
      { text: 'Всього по розділу:', bold: true, fontSize: 9, alignment: 'right', verticalAlignment: 'middle' },
      { text: money(sectionTotal), bold: true, fontSize: 9, alignment: 'center', verticalAlignment: 'middle' },
    ])

    content.push({
      table: { headerRows: 1, widths: [20, '*', 30, 40, 70, 80], body },
      layout: { hLineWidth: () => 0.5, vLineWidth: () => 0.5, hLineColor: () => '#ccc', vLineColor: () => '#ccc' },
    })
  })

  content.push({
    margin: [0, 16, 0, 0],
    table: {
      widths: ['*', 120],
      body: [
        [
          { text: 'Роботи:', fontSize: 10, alignment: 'right', border: [false, false, false, false] },
          { text: money(totals.workKoshtorys), fontSize: 10, alignment: 'right', border: [false, false, false, false] },
        ],
        [
          { text: 'Матеріали:', fontSize: 10, alignment: 'right', border: [false, false, false, false] },
          { text: money(totals.matKoshtorys), fontSize: 10, alignment: 'right', border: [false, false, false, false] },
        ],
      ],
    },
    layout: 'noBorders',
  })

  content.push(...buildLimitsBlock(vedomost, totals))

  content.push({
    margin: [0, 12, 0, 0],
    table: {
      widths: ['*', 120],
      body: [
        [
          { text: 'ВСЬОГО:', bold: true, fontSize: 14, alignment: 'right', border: [false, false, false, false] },
          { text: money(totals.grandTotal), bold: true, fontSize: 14, alignment: 'right', border: [false, false, false, false] },
        ],
      ],
    },
    layout: 'noBorders',
  })

  content.push(...buildFooter(vedomost))

  return { content, styles: buildStyles(), defaultStyle: { font: 'Roboto' }, pageSize: 'A4', pageOrientation: 'portrait' }
}

// ============ 9-ТИ ГРАФКА ============

function build9Graph(vedomost, companySettings, totals, palette) {
  const content = [
    ...buildHeader(vedomost, companySettings, 'КОШТОРИС', true),
    { text: 'Роботи та матеріали', style: 'h2', margin: [0, 0, 0, 8] },
  ]

  const headerFill = palette.bg || undefined
  const headerText = palette.text

  vedomost.sections?.forEach((section, idx) => {
    content.push({
      text: `${idx + 1}. ${section.name || 'Без назви'}`,
      bold: true,
      fontSize: 11,
      margin: [0, 12, 0, 6],
    })

    const body = [
      [
        { text: '№', bold: true, fontSize: 8, alignment: 'center', rowSpan: 2, verticalAlignment: 'middle', fillColor: headerFill, color: headerText },
        { text: 'Найменування робіт, матеріалів, витрат', bold: true, fontSize: 8, alignment: 'center', rowSpan: 2, verticalAlignment: 'middle', fillColor: headerFill, color: headerText },
        { text: 'Од. вим.', bold: true, fontSize: 8, alignment: 'center', rowSpan: 2, verticalAlignment: 'middle', fillColor: headerFill, color: headerText },
        { text: 'К-сть', bold: true, fontSize: 8, alignment: 'center', rowSpan: 2, verticalAlignment: 'middle', fillColor: headerFill, color: headerText },
        { text: 'Ціна одиниці, грн.', bold: true, fontSize: 8, alignment: 'center', colSpan: 2, verticalAlignment: 'middle', fillColor: headerFill, color: headerText },
        {},
        { text: 'Вартість, грн.', bold: true, fontSize: 8, alignment: 'center', colSpan: 3, verticalAlignment: 'middle', fillColor: headerFill, color: headerText },
        {},
        {},
      ],
      [
        {},
        {},
        {},
        {},
        { text: 'Роботи', bold: true, fontSize: 8, alignment: 'center', verticalAlignment: 'middle', fillColor: headerFill, color: headerText },
        { text: 'Матеріали', bold: true, fontSize: 8, alignment: 'center', verticalAlignment: 'middle', fillColor: headerFill, color: headerText },
        { text: 'Роботи', bold: true, fontSize: 8, alignment: 'center', verticalAlignment: 'middle', fillColor: headerFill, color: headerText },
        { text: 'Матеріали', bold: true, fontSize: 8, alignment: 'center', verticalAlignment: 'middle', fillColor: headerFill, color: headerText },
        { text: 'Всього', bold: true, fontSize: 8, alignment: 'center', verticalAlignment: 'middle', fillColor: headerFill, color: headerText },
      ],
    ]

    let n = 1
    let sectionWorkTotal = 0
    let sectionMatTotal = 0

    section.items?.forEach((item) => {
      const qty = item.quantity || 0
      const pw = item.priceWorker || 0
      const pc = item.priceClient || 0
      const workSum = qty * pc
      sectionWorkTotal += workSum

      body.push([
        { text: String(n++), fontSize: 8, alignment: 'center', verticalAlignment: 'middle' },
        { text: item.name || '—', fontSize: 8, verticalAlignment: 'middle' },
        { text: item.unit || '', fontSize: 8, alignment: 'center', verticalAlignment: 'middle' },
        { text: number(qty), fontSize: 8, alignment: 'center', verticalAlignment: 'middle' },
        { text: money(pw), fontSize: 8, alignment: 'center', verticalAlignment: 'middle' },
        { text: '', fontSize: 8, verticalAlignment: 'middle' },
        { text: money(workSum), fontSize: 8, alignment: 'center', verticalAlignment: 'middle' },
        { text: '', fontSize: 8, verticalAlignment: 'middle' },
        { text: money(workSum), fontSize: 8, alignment: 'center', verticalAlignment: 'middle' },
      ])

      item.materials?.forEach((mat) => {
        const isCustomer = mat.isCustomerSupplied
        const mq = isCustomer ? mat.quantity || 0 : roundUp(mat.quantity || 0)
        const mc = mat.priceClient || 0
        const matSum = isCustomer ? 0 : mq * mc
        if (!isCustomer) sectionMatTotal += matSum

        body.push([
          { text: '', fontSize: 7, verticalAlignment: 'middle' },
          { text: '  • ' + (mat.name || ''), fontSize: 7, color: '#555', verticalAlignment: 'middle' },
          { text: mat.unit || '', fontSize: 7, alignment: 'center', color: '#555', verticalAlignment: 'middle' },
          { text: number(mq, 0), fontSize: 7, alignment: 'center', color: '#555', verticalAlignment: 'middle' },
          { text: '', fontSize: 7, verticalAlignment: 'middle' },
          {
            text: isCustomer ? 'Замовник' : money(mc),
            fontSize: 7,
            alignment: 'center',
            color: isCustomer ? '#059669' : '#555',
            italics: isCustomer,
            verticalAlignment: 'middle',
          },
          { text: '', fontSize: 7, verticalAlignment: 'middle' },
          {
            text: isCustomer ? '—' : money(matSum),
            fontSize: 7,
            alignment: 'center',
            color: '#555',
            verticalAlignment: 'middle',
          },
          {
            text: isCustomer ? '—' : money(matSum),
            fontSize: 7,
            alignment: 'center',
            color: '#555',
            verticalAlignment: 'middle',
          },
        ])
      })
    })

    body.push([
      { text: '', colSpan: 4, border: [false, false, false, false] },
      {},
      {},
      {},
      { text: 'Всього по розділу:', bold: true, fontSize: 8, alignment: 'right', verticalAlignment: 'middle', colSpan: 2, border: [false, false, false, false] },
      {},
      { text: money(sectionWorkTotal), bold: true, fontSize: 8, alignment: 'center', verticalAlignment: 'middle' },
      { text: money(sectionMatTotal), bold: true, fontSize: 8, alignment: 'center', verticalAlignment: 'middle' },
      { text: money(sectionWorkTotal + sectionMatTotal), bold: true, fontSize: 8, alignment: 'center', verticalAlignment: 'middle' },
    ])

    content.push({
      table: { headerRows: 2, widths: [18, '*', 28, 32, 55, 55, 65, 65, 70], body },
      layout: { hLineWidth: () => 0.5, vLineWidth: () => 0.5, hLineColor: () => '#ccc', vLineColor: () => '#ccc' },
    })
  })

  const summaryRows = [
    [
      { text: 'Разом по роботах:', bold: true, fontSize: 10, alignment: 'right', border: [false, false, false, false] },
      { text: money(totals.workKoshtorys), bold: true, fontSize: 10, alignment: 'right', border: [false, false, false, false] },
    ],
    [
      { text: 'Разом по матеріалах:', bold: true, fontSize: 10, alignment: 'right', border: [false, false, false, false] },
      { text: money(totals.matKoshtorys), bold: true, fontSize: 10, alignment: 'right', border: [false, false, false, false] },
    ],
  ]

  totals.limits.forEach((lim) => {
    if (lim.amount > 0) {
      summaryRows.push([
        {
          text: `${lim.name} (${lim.percent}% ${baseLabel(lim.base)}):`,
          fontSize: 9,
          alignment: 'right',
          border: [false, false, false, false],
        },
        {
          text: money(lim.amount),
          fontSize: 9,
          alignment: 'right',
          border: [false, false, false, false],
        },
      ])
    }
  })

  summaryRows.push([
    { text: 'Проміжний підсумок:', bold: true, fontSize: 10, alignment: 'right', border: [false, true, false, false] },
    { text: money(totals.subTotal), bold: true, fontSize: 10, alignment: 'right', border: [false, true, false, false] },
  ])

  if (vedomost.vatPercent > 0) {
    summaryRows.push([
      {
        text: `ПДВ ${vedomost.vatPercent}% (${baseLabel(vedomost.vatBase)}):`,
        fontSize: 10,
        alignment: 'right',
        border: [false, false, false, false],
      },
      {
        text: money(totals.vat),
        fontSize: 10,
        alignment: 'right',
        border: [false, false, false, false],
      },
    ])
  }

  summaryRows.push([
    { text: 'ВСЬОГО:', bold: true, fontSize: 14, alignment: 'right', border: [false, true, false, false] },
    { text: money(totals.grandTotal), bold: true, fontSize: 14, alignment: 'right', border: [false, true, false, false] },
  ])

  content.push({
    margin: [0, 16, 0, 0],
    table: {
      widths: ['*', 140],
      body: summaryRows,
    },
    layout: 'noBorders',
    alignment: 'right',
  })

  content.push(...buildFooter(vedomost))

  return { content, styles: buildStyles(), defaultStyle: { font: 'Roboto' }, pageSize: 'A4', pageOrientation: 'landscape' }
}

// ============ НАРЯД ============

function buildNaryad(vedomost, companySettings, totals, palette) {
  const content = [
    ...buildHeader(vedomost, companySettings, 'НАРЯД НА РОБОТИ', false),
    { text: 'Роботи', style: 'h2', margin: [0, 0, 0, 8] },
  ]

  const headerFill = palette.bg || undefined
  const headerText = palette.text

  vedomost.sections?.forEach((section, idx) => {
    content.push({
      text: `${idx + 1}. ${section.name || 'Без назви'}`,
      bold: true,
      fontSize: 12,
      margin: [0, 12, 0, 6],
    })

    const body = [
      [
        { text: '№', bold: true, fontSize: 9, alignment: 'center', verticalAlignment: 'middle', fillColor: headerFill, color: headerText },
        { text: 'Найменування робіт', bold: true, fontSize: 9, verticalAlignment: 'middle', fillColor: headerFill, color: headerText },
        { text: 'Од.', bold: true, fontSize: 9, alignment: 'center', verticalAlignment: 'middle', fillColor: headerFill, color: headerText },
        { text: 'К-сть', bold: true, fontSize: 9, alignment: 'center', verticalAlignment: 'middle', fillColor: headerFill, color: headerText },
        { text: 'Ціна (наряд)', bold: true, fontSize: 9, alignment: 'center', verticalAlignment: 'middle', fillColor: headerFill, color: headerText },
        { text: 'Сума', bold: true, fontSize: 9, alignment: 'center', verticalAlignment: 'middle', fillColor: headerFill, color: headerText },
      ],
    ]

    let n = 1
    let sectionTotal = 0
    section.items?.forEach((item) => {
      const qty = item.quantity || 0
      const price = item.priceWorker || 0
      sectionTotal += qty * price
      body.push([
        { text: String(n++), fontSize: 9, alignment: 'center', verticalAlignment: 'middle' },
        { text: item.name || '—', fontSize: 9, verticalAlignment: 'middle' },
        { text: item.unit || '', fontSize: 9, alignment: 'center', verticalAlignment: 'middle' },
        { text: number(qty), fontSize: 9, alignment: 'center', verticalAlignment: 'middle' },
        { text: money(price), fontSize: 9, alignment: 'center', verticalAlignment: 'middle' },
        { text: money(qty * price), fontSize: 9, alignment: 'center', verticalAlignment: 'middle' },
      ])
    })

    body.push([
      { text: '', colSpan: 5, border: [false, false, false, false] },
      {}, {}, {},
      { text: 'Всього по розділу:', bold: true, fontSize: 9, alignment: 'right', verticalAlignment: 'middle' },
      { text: money(sectionTotal), bold: true, fontSize: 9, alignment: 'center', verticalAlignment: 'middle' },
    ])

    content.push({
      table: { headerRows: 1, widths: [20, '*', 30, 40, 80, 80], body },
      layout: { hLineWidth: () => 0.5, vLineWidth: () => 0.5, hLineColor: () => '#ccc', vLineColor: () => '#ccc' },
    })
  })

  content.push({
    margin: [0, 16, 0, 0],
    table: {
      widths: ['*', 120],
      body: [
        [
          { text: 'ВСЬОГО ДО ВИПЛАТИ:', bold: true, fontSize: 12, alignment: 'right', border: [false, false, false, false] },
          { text: money(totals.workNaryad), bold: true, fontSize: 13, alignment: 'right', border: [false, false, false, false] },
        ],
      ],
    },
    layout: 'noBorders',
  })

  content.push({
    margin: [0, 40, 0, 0],
    columns: [
      { width: '*', stack: [{ text: 'Виконавець', fontSize: 10 }, { text: '__________________', margin: [0, 30, 0, 0] }] },
      { width: '*', stack: [{ text: 'Бригадир / робітник', fontSize: 10 }, { text: '__________________', margin: [0, 30, 0, 0] }] },
    ],
  })

  return { content, styles: buildStyles(), defaultStyle: { font: 'Roboto' }, pageSize: 'A4', pageOrientation: 'portrait' }
}

// ============ ВЕДОМОСТЬ МАТЕРИАЛОВ ============

function buildVedomistMaterials(vedomost, companySettings, palette) {
  const content = [
    ...buildHeader(vedomost, companySettings, 'ВЕДОМІСТЬ МАТЕРІАЛІВ', false),
    { text: 'Перелік матеріалів', style: 'h2', margin: [0, 0, 0, 8] },
  ]

  const headerFill = palette.bg || undefined
  const headerText = palette.text

  const allMaterials = []
  vedomost.sections?.forEach((section) => {
    section.items?.forEach((item) => {
      item.materials?.forEach((mat) => {
        if (mat.isCustomerSupplied) return
        allMaterials.push(mat)
      })
    })
  })

  const body = [
    [
      { text: '№', bold: true, fontSize: 10, alignment: 'center', verticalAlignment: 'middle', fillColor: headerFill, color: headerText },
      { text: 'Найменування матеріалу', bold: true, fontSize: 10, verticalAlignment: 'middle', fillColor: headerFill, color: headerText },
      { text: 'Од.', bold: true, fontSize: 10, alignment: 'center', verticalAlignment: 'middle', fillColor: headerFill, color: headerText },
      { text: 'К-сть', bold: true, fontSize: 10, alignment: 'center', verticalAlignment: 'middle', fillColor: headerFill, color: headerText },
      { text: 'Ціна', bold: true, fontSize: 10, alignment: 'center', verticalAlignment: 'middle', fillColor: headerFill, color: headerText },
      { text: 'Сума', bold: true, fontSize: 10, alignment: 'center', verticalAlignment: 'middle', fillColor: headerFill, color: headerText },
    ],
  ]

  let total = 0
  allMaterials.forEach((mat, i) => {
    const qty = roundUp(mat.quantity || 0)
    const price = mat.pricePurchase || 0
    total += qty * price
    body.push([
      { text: String(i + 1), fontSize: 10, alignment: 'center', verticalAlignment: 'middle' },
      { text: mat.name || '—', fontSize: 10, verticalAlignment: 'middle' },
      { text: mat.unit || '', fontSize: 10, alignment: 'center', verticalAlignment: 'middle' },
      { text: number(qty, 0), fontSize: 10, alignment: 'center', verticalAlignment: 'middle' },
      { text: money(price), fontSize: 10, alignment: 'center', verticalAlignment: 'middle' },
      { text: money(qty * price), fontSize: 10, alignment: 'center', verticalAlignment: 'middle' },
    ])
  })

  content.push({
    table: { headerRows: 1, widths: [25, '*', 40, 50, 80, 90], body },
    layout: { hLineWidth: () => 0.5, vLineWidth: () => 0.5, hLineColor: () => '#ccc', vLineColor: () => '#ccc' },
  })

  content.push({
    margin: [0, 16, 0, 0],
    table: {
      widths: ['*', 120],
      body: [
        [
          { text: 'ВСЬОГО:', bold: true, fontSize: 12, alignment: 'right', border: [false, false, false, false] },
          { text: money(total), bold: true, fontSize: 13, alignment: 'right', border: [false, false, false, false] },
        ],
      ],
    },
    layout: 'noBorders',
  })

  return { content, styles: buildStyles(), defaultStyle: { font: 'Roboto' }, pageSize: 'A4', pageOrientation: 'portrait' }
}

// ============ РОУТ ============

router.get('/:id/pdf', async (req, res) => {
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

    let docDefinition
    let filename

    switch (type) {
      case 'naryad':
        docDefinition = buildNaryad(vedomost, companySettings, totals, palette)
        filename = `naryad-${vedomost.number || id}.pdf`
        break
      case 'zakupivlya':
      case 'vedomist':
        docDefinition = buildVedomistMaterials(vedomost, companySettings, palette)
        filename = `vedomist-materialiv-${vedomost.number || id}.pdf`
        break
      case 'full':
      case '9graph':
        docDefinition = build9Graph(vedomost, companySettings, totals, palette)
        filename = `koshtorys-9graph-${vedomost.number || id}.pdf`
        break
      case 'koshtorys':
      case '6graph':
      default:
        docDefinition = buildKoshtorys(vedomost, companySettings, totals, palette)
        filename = `koshtorys-6graph-${vedomost.number || id}.pdf`
        break
    }

    const pdfDoc = printer.createPdfKitDocument(docDefinition)

    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', `inline; filename="${filename}"`)

    pdfDoc.pipe(res)
    pdfDoc.end()
  } catch (error) {
    console.error('Помилка генерації PDF:', error)
    res.status(500).json({ error: error.message })
  }
})

module.exports = router