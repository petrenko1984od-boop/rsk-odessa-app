const express = require('express')
const router = express.Router()
const prisma = require('../prisma')

// GET /api/materials — список всех материалов
router.get('/', async (req, res) => {
  try {
    const { sectionId } = req.query
    const where = {}

    if (sectionId === 'null' || sectionId === 'none') {
      where.materialSectionId = null
    } else if (sectionId) {
      where.materialSectionId = sectionId
    }

    const materials = await prisma.catalogMaterial.findMany({
      where,
      orderBy: { name: 'asc' },
      include: { materialSection: true },
    })
    res.json(materials)
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
})

// GET /api/materials/:id
router.get('/:id', async (req, res) => {
  try {
    const material = await prisma.catalogMaterial.findUnique({
      where: { id: req.params.id },
      include: { materialSection: true },
    })
    if (!material) return res.status(404).json({ error: 'Матеріал не знайдено' })
    res.json(material)
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
})

// POST /api/materials — создать
router.post('/', async (req, res) => {
  try {
    const {
      name,
      unit,
      pricePurchase,
      priceClient,
      materialSectionId,
      isCustomerSupplied,
      userId,
    } = req.body
    const finalUserId = userId || (await getDefaultUserId())

    const material = await prisma.catalogMaterial.create({
      data: {
        name,
        unit,
        pricePurchase: parseFloat(pricePurchase) || 0,
        priceClient: parseFloat(priceClient) || 0,
        isCustomerSupplied: Boolean(isCustomerSupplied),
        materialSectionId: materialSectionId || null,
        userId: finalUserId,
      },
      include: { materialSection: true },
    })
    res.status(201).json(material)
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
})

// PUT /api/materials/:id
router.put('/:id', async (req, res) => {
  try {
    const {
      name,
      unit,
      pricePurchase,
      priceClient,
      materialSectionId,
      isCustomerSupplied,
    } = req.body
    const material = await prisma.catalogMaterial.update({
      where: { id: req.params.id },
      data: {
        name,
        unit,
        pricePurchase: parseFloat(pricePurchase) || 0,
        priceClient: parseFloat(priceClient) || 0,
        isCustomerSupplied: Boolean(isCustomerSupplied),
        materialSectionId: materialSectionId || null,
      },
      include: { materialSection: true },
    })
    res.json(material)
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
})

// DELETE /api/materials/:id
router.delete('/:id', async (req, res) => {
  try {
    await prisma.catalogMaterial.delete({
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