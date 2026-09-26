const express = require('express')
const router = express.Router()
const prisma = require('../prisma')

// GET /api/material-sections — список всех разделов/подразделов
// ?parentId=null — только родительские
// ?parentId=xxx  — только дети указанного родителя
// ?tree=true     — вернуть дерево (родители с детьми)
router.get('/', async (req, res) => {
  try {
    const { parentId, tree } = req.query

    if (tree === 'true') {
      const roots = await prisma.materialSection.findMany({
        where: { parentId: null },
        orderBy: [{ order: 'asc' }, { name: 'asc' }],
        include: {
          children: {
            orderBy: [{ order: 'asc' }, { name: 'asc' }],
            include: {
              _count: { select: { materials: true } },
            },
          },
          _count: { select: { materials: true } },
        },
      })
      return res.json(roots)
    }

    let where = {}
    if (parentId === 'null') {
      where.parentId = null
    } else if (parentId) {
      where.parentId = parentId
    }

    const sections = await prisma.materialSection.findMany({
      where,
      orderBy: [{ order: 'asc' }, { name: 'asc' }],
      include: {
        parent: true,
        _count: {
          select: { materials: true },
        },
      },
    })
    res.json(sections)
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
})

// GET /api/material-sections/:id — один раздел с материалами
router.get('/:id', async (req, res) => {
  try {
    const section = await prisma.materialSection.findUnique({
      where: { id: req.params.id },
      include: {
        parent: true,
        children: true,
        materials: {
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

// POST /api/material-sections — создать
router.post('/', async (req, res) => {
  try {
    const { name, order, parentId, userId } = req.body
    const finalUserId = userId || await getDefaultUserId()

    const section = await prisma.materialSection.create({
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

// PUT /api/material-sections/:id — обновить
router.put('/:id', async (req, res) => {
  try {
    const { name, order, parentId } = req.body
    const section = await prisma.materialSection.update({
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

// DELETE /api/material-sections/:id — удалить
router.delete('/:id', async (req, res) => {
  try {
    await prisma.materialSection.delete({
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