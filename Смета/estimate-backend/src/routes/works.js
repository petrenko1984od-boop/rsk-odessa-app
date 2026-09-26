const express = require('express')
const router = express.Router()
const prisma = require('../prisma')

// GET /api/works — список всех работ (можно фильтровать по sectionId)
router.get('/', async (req, res) => {
  try {
    const { sectionId } = req.query
    const where = {}

    if (sectionId === 'null' || sectionId === 'none') {
      where.sectionId = null
    } else if (sectionId) {
      where.sectionId = sectionId
    }

    const works = await prisma.catalogWork.findMany({
      where,
      orderBy: { name: 'asc' },
      include: {
        section: true,
        materials: {
          include: { material: true }
        }
      }
    })
    res.json(works)
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
})

// GET /api/works/:id — одна работа
router.get('/:id', async (req, res) => {
  try {
    const work = await prisma.catalogWork.findUnique({
      where: { id: req.params.id },
      include: {
        section: true,
        materials: {
          include: { material: true }
        }
      }
    })
    if (!work) return res.status(404).json({ error: 'Роботу не знайдено' })
    res.json(work)
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
})

// POST /api/works — создать работу
router.post('/', async (req, res) => {
  try {
    const { name, unit, priceWorker, priceClient, description, sectionId, userId } = req.body
    const finalUserId = userId || await getDefaultUserId()

    const work = await prisma.catalogWork.create({
      data: {
        name,
        unit,
        priceWorker: parseFloat(priceWorker) || 0,
        priceClient: parseFloat(priceClient) || 0,
        description: description || null,
        sectionId: sectionId || null,
        userId: finalUserId
      },
      include: {
        section: true,
        materials: {
          include: { material: true }
        }
      }
    })
    res.status(201).json(work)
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
})

// PUT /api/works/:id — обновить работу
router.put('/:id', async (req, res) => {
  try {
    const { name, unit, priceWorker, priceClient, description, sectionId } = req.body
    const work = await prisma.catalogWork.update({
      where: { id: req.params.id },
      data: {
        name,
        unit,
        priceWorker: parseFloat(priceWorker) || 0,
        priceClient: parseFloat(priceClient) || 0,
        description: description || null,
        sectionId: sectionId || null
      },
      include: {
        section: true,
        materials: {
          include: { material: true }
        }
      }
    })
    res.json(work)
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
})

// DELETE /api/works/:id — удалить работу
router.delete('/:id', async (req, res) => {
  try {
    await prisma.catalogWork.delete({
      where: { id: req.params.id }
    })
    res.json({ success: true })
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
})

// ============================================
// ПРИВЯЗКА МАТЕРИАЛОВ К РАБОТЕ
// ============================================

router.post('/:workId/materials', async (req, res) => {
  try {
    const { materialId, consumption } = req.body
    const { workId } = req.params

    const existing = await prisma.workMaterial.findFirst({
      where: { workId, materialId }
    })

    if (existing) {
      const updated = await prisma.workMaterial.update({
        where: { id: existing.id },
        data: { consumption: parseFloat(consumption) || 0 },
        include: { material: true }
      })
      return res.json(updated)
    }

    const link = await prisma.workMaterial.create({
      data: {
        workId,
        materialId,
        consumption: parseFloat(consumption) || 0
      },
      include: { material: true }
    })
    res.status(201).json(link)
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
})

router.put('/:workId/materials/:linkId', async (req, res) => {
  try {
    const { consumption } = req.body
    const updated = await prisma.workMaterial.update({
      where: { id: req.params.linkId },
      data: { consumption: parseFloat(consumption) || 0 },
      include: { material: true }
    })
    res.json(updated)
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
})

router.delete('/:workId/materials/:linkId', async (req, res) => {
  try {
    await prisma.workMaterial.delete({
      where: { id: req.params.linkId }
    })
    res.json({ success: true })
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
})

// ============================================

async function getDefaultUserId() {
  let user = await prisma.user.findFirst()
  if (!user) {
    user = await prisma.user.create({
      data: { email: 'default@local', name: 'Default User' }
    })
  }
  return user.id
}

module.exports = router
