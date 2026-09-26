const express = require('express')
const router = express.Router()
const prisma = require('../prisma')

// Генерация следующего номера сметы
async function generateNumber(userId) {
  const currentYear = new Date().getFullYear()

  const last = await prisma.vedomost.findFirst({
    where: { userId, numberYear: currentYear },
    orderBy: { numberSeq: 'desc' },
  })

  const nextSeq = last ? last.numberSeq + 1 : 1
  const numberStr = String(nextSeq).padStart(5, '0') + '/' + currentYear

  return { number: numberStr, numberYear: currentYear, numberSeq: nextSeq }
}

// GET /api/vedomosti
router.get('/', async (req, res) => {
  try {
    const vedomosti = await prisma.vedomost.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        client: true,
        limits: { orderBy: { order: 'asc' } },
        sections: {
          include: {
            items: {
              include: { materials: true },
            },
          },
        },
      },
    })
    res.json(vedomosti)
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
})

// GET /api/vedomosti/:id
router.get('/:id', async (req, res) => {
  try {
    const vedomost = await prisma.vedomost.findUnique({
      where: { id: req.params.id },
      include: {
        client: true,
        limits: { orderBy: { order: 'asc' } },
        sections: {
          orderBy: { order: 'asc' },
          include: {
            items: {
              include: {
                materials: true,
                catalogWork: true,
              },
            },
          },
        },
      },
    })
    if (!vedomost) return res.status(404).json({ error: 'Відомість не знайдена' })
    res.json(vedomost)
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
})

// POST /api/vedomosti
router.post('/', async (req, res) => {
  try {
    const {
      title,
      object,
      clientId,
      sections,
      limits,
      notes,
      vatPercent,
      vatBase,
      userId,
    } = req.body

    const finalUserId = userId || (await getDefaultUserId())
    const { number, numberYear, numberSeq } = await generateNumber(finalUserId)

    let finalNotes = notes
    if (!finalNotes) {
      const settings = await prisma.companySettings.findUnique({
        where: { userId: finalUserId },
      })
      if (settings?.defaultNotes) {
        finalNotes = settings.defaultNotes
      }
    }

    const vedomost = await prisma.vedomost.create({
      data: {
        title,
        object: object || null,
        clientId: clientId || null,
        userId: finalUserId,

        number,
        numberYear,
        numberSeq,

        notes: finalNotes || null,

        vatPercent: parseFloat(vatPercent) || 0,
        vatBase: vatBase || 'both',

        limits: {
          create: (limits || []).map((lim, idx) => ({
            name: lim.name || '',
            percent: parseFloat(lim.percent) || 0,
            base: lim.base || 'both',
            order: idx,
          })),
        },

        sections: {
          create: (sections || []).map((section, sIdx) => ({
            name: section.name || `Розділ ${sIdx + 1}`,
            order: sIdx,
            items: {
              create: (section.items || []).map((item) => ({
                name: item.name,
                unit: item.unit || '',
                quantity: parseFloat(item.quantity) || 0,
                priceWorker: parseFloat(item.priceWorker) || 0,
                priceClient: parseFloat(item.priceClient) || 0,
                catalogWorkId: item.catalogWorkId || null,
                materials: {
                  create: (item.materials || []).map((mat) => ({
                    name: mat.name,
                    unit: mat.unit || '',
                    quantity: parseFloat(mat.quantity) || 0,
                    pricePurchase: parseFloat(mat.pricePurchase) || 0,
                    priceClient: parseFloat(mat.priceClient) || 0,
                    consumption: mat.consumption ? parseFloat(mat.consumption) : null,
                    isCustomerSupplied: Boolean(mat.isCustomerSupplied),
                    catalogMaterialId: mat.catalogMaterialId || null,
                  })),
                },
              })),
            },
          })),
        },
      },
      include: {
        client: true,
        limits: { orderBy: { order: 'asc' } },
        sections: {
          include: {
            items: {
              include: { materials: true },
            },
          },
        },
      },
    })

    res.status(201).json(vedomost)
  } catch (error) {
    console.error('Помилка створення відомості:', error)
    res.status(500).json({ error: error.message })
  }
})

// PUT /api/vedomosti/:id
router.put('/:id', async (req, res) => {
  try {
    const {
      title,
      object,
      clientId,
      sections,
      limits,
      notes,
      vatPercent,
      vatBase,
    } = req.body
    const { id } = req.params

    await prisma.vedomost.update({
      where: { id },
      data: {
        title,
        object: object || null,
        clientId: clientId || null,
        notes: notes || null,
        vatPercent: parseFloat(vatPercent) || 0,
        vatBase: vatBase || 'both',
      },
    })

    await prisma.vedomostLimit.deleteMany({ where: { vedomostId: id } })
    await prisma.vedomostSection.deleteMany({ where: { vedomostId: id } })

    for (let i = 0; i < (limits || []).length; i++) {
      const lim = limits[i]
      await prisma.vedomostLimit.create({
        data: {
          vedomostId: id,
          name: lim.name || '',
          percent: parseFloat(lim.percent) || 0,
          base: lim.base || 'both',
          order: i,
        },
      })
    }

    for (let sIdx = 0; sIdx < (sections || []).length; sIdx++) {
      const section = sections[sIdx]
      await prisma.vedomostSection.create({
        data: {
          vedomostId: id,
          name: section.name || `Розділ ${sIdx + 1}`,
          order: sIdx,
          items: {
            create: (section.items || []).map((item) => ({
              name: item.name,
              unit: item.unit || '',
              quantity: parseFloat(item.quantity) || 0,
              priceWorker: parseFloat(item.priceWorker) || 0,
              priceClient: parseFloat(item.priceClient) || 0,
              catalogWorkId: item.catalogWorkId || null,
              materials: {
                create: (item.materials || []).map((mat) => ({
                  name: mat.name,
                  unit: mat.unit || '',
                  quantity: parseFloat(mat.quantity) || 0,
                  pricePurchase: parseFloat(mat.pricePurchase) || 0,
                  priceClient: parseFloat(mat.priceClient) || 0,
                  consumption: mat.consumption ? parseFloat(mat.consumption) : null,
                  isCustomerSupplied: Boolean(mat.isCustomerSupplied),
                  catalogMaterialId: mat.catalogMaterialId || null,
                })),
              },
            })),
          },
        },
      })
    }

    const updated = await prisma.vedomost.findUnique({
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

    res.json(updated)
  } catch (error) {
    console.error('Помилка оновлення відомості:', error)
    res.status(500).json({ error: error.message })
  }
})

// DELETE /api/vedomosti/:id
router.delete('/:id', async (req, res) => {
  try {
    await prisma.vedomost.delete({
      where: { id: req.params.id },
    })
    res.json({ success: true })
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
})

async function getDefaultUserId() {
  let user = await prisma.user.findFirst()
  if (!user) {
    user = await prisma.user.create({
      data: { email: 'default@local', name: 'Default User' },
    })
  }
  return user.id
}

module.exports = router