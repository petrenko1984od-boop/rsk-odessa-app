const express = require('express')
const router = express.Router()
const prisma = require('../prisma')

// GET /api/catalog-units — список всех единиц
router.get('/', async (req, res) => {
  try {
    const units = await prisma.catalogUnit.findMany({
      orderBy: [{ order: 'asc' }, { name: 'asc' }],
    })
    res.json(units)
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
})

// POST /api/catalog-units — создать единицу
router.post('/', async (req, res) => {
  try {
    const { name, fullName, order } = req.body

    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Введіть назву одиниці' })
    }

    const unit = await prisma.catalogUnit.create({
      data: {
        name: name.trim(),
        fullName: fullName ? fullName.trim() : null,
        order: parseInt(order) || 0,
      },
    })
    res.status(201).json(unit)
  } catch (error) {
    if (error.code === 'P2002') {
      return res.status(400).json({ error: 'Така одиниця вже існує' })
    }
    res.status(500).json({ error: error.message })
  }
})

// PUT /api/catalog-units/:id — обновить
router.put('/:id', async (req, res) => {
  try {
    const { name, fullName, order } = req.body
    const unit = await prisma.catalogUnit.update({
      where: { id: req.params.id },
      data: {
        name: name ? name.trim() : undefined,
        fullName: fullName !== undefined ? fullName.trim() || null : undefined,
        order: order !== undefined ? parseInt(order) || 0 : undefined,
      },
    })
    res.json(unit)
  } catch (error) {
    if (error.code === 'P2002') {
      return res.status(400).json({ error: 'Така одиниця вже існує' })
    }
    res.status(500).json({ error: error.message })
  }
})

// DELETE /api/catalog-units/:id — удалить
router.delete('/:id', async (req, res) => {
  try {
    await prisma.catalogUnit.delete({
      where: { id: req.params.id },
    })
    res.json({ success: true })
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
})

module.exports = router