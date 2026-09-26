const express = require('express')
const router = express.Router()
const prisma = require('../prisma')

// GET /api/catalog-sections — список всех разделов/подразделов
// ?parentId=null — только родительские
// ?parentId=xxx  — только дети указанного родителя
// ?tree=true     — вернуть дерево (родители с детьми)
router.get('/', async (req, res) => {
  try {
    const { parentId, tree } = req.query

    // Дерево
    if (tree === 'true') {
      const roots = await prisma.catalogSection.findMany({
        where: { parentId: null },
        orderBy: [{ order: 'asc' }, { name: 'asc' }],
        include: {
          children: {
            orderBy: [{ order: 'asc' }, { name: 'asc' }],
            include: {
              _count: { select: { works: true } },
            },
          },
          _count: { select: { works: true } },
        },
      })
      return res.json(roots)
    }

    // Фильтр по parentId
    let where = {}
    if (parentId === 'null') {
      where.parentId = null
    } else if (parentId) {
      where.parentId = parentId
    }

    const sections = await prisma.catalogSection.findMany({
      where,
      orderBy: [{ order: 'asc' }, { name: 'asc' }],
      include: {
        parent: true,
        _count: {
          select: { works: true },
        },
      },
    })
    res.json(sections)
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
})

// GET /api/catalog-sections/:id — один раздел с работами
router.get('/:id', async (req, res) => {
  try {
    const section = await prisma.catalogSection.findUnique({
      where: { id: req.params.id },
      include: {
        parent: true,
        children: true,
        works: {
          orderBy: { name: 'asc' },
        },
      },
    })
    if (!section) return res.status(404).json({ error: 'Розділ не знайдено' })
    res.json(section)
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
})

// POST /api/catalog-sections — создать
router.post('/', async (req, res) => {
  try {
    const { name, order, parentId, userId } = req.body
    const finalUserId = userId || await getDefaultUserId()

    const section = await prisma.catalogSection.create({
      data: {
        name,
        order: parseInt(order) || 0,
        parentId: parentId || null,
        userId: finalUserId,
      },
      include: { parent: true },
    })
    res.status(201).json(section)
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
})

// PUT /api/catalog-sections/:id — обновить
router.put('/:id', async (req, res) => {
  try {
    const { name, order, parentId } = req.body
    const section = await prisma.catalogSection.update({
      where: { id: req.params.id },
      data: {
        name,
        order: parseInt(order) || 0,
        parentId: parentId || null,
      },
      include: { parent: true },
    })
    res.json(section)
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
})

// DELETE /api/catalog-sections/:id — удалить
router.delete('/:id', async (req, res) => {
  try {
    await prisma.catalogSection.delete({
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