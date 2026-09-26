const express = require('express')
const router = express.Router()
const prisma = require('../prisma')

// GET /api/clients — список всех клиентов
router.get('/', async (req, res) => {
  try {
    const clients = await prisma.client.findMany({
      orderBy: { name: 'asc' },
      include: {
        _count: {
          select: { vedomosti: true },
        },
      },
    })
    res.json(clients)
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
})

// GET /api/clients/:id — один клиент
router.get('/:id', async (req, res) => {
  try {
    const client = await prisma.client.findUnique({
      where: { id: req.params.id },
      include: {
        vedomosti: {
          orderBy: { createdAt: 'desc' },
          select: {
            id: true,
            number: true,
            title: true,
            createdAt: true,
          },
        },
      },
    })
    if (!client) return res.status(404).json({ error: 'Клієнта не знайдено' })
    res.json(client)
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
})

// POST /api/clients — создать клиента
router.post('/', async (req, res) => {
  try {
    const { name, phone, email, address, userId } = req.body

    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Введіть ім\'я клієнта' })
    }

    const finalUserId = userId || (await getDefaultUserId())

    const client = await prisma.client.create({
      data: {
        name: name.trim(),
        phone: phone ? phone.trim() : null,
        email: email ? email.trim() : null,
        address: address ? address.trim() : null,
        userId: finalUserId,
      },
    })
    res.status(201).json(client)
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
})

// PUT /api/clients/:id — обновить клиента
router.put('/:id', async (req, res) => {
  try {
    const { name, phone, email, address } = req.body

    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Введіть ім\'я клієнта' })
    }

    const client = await prisma.client.update({
      where: { id: req.params.id },
      data: {
        name: name.trim(),
        phone: phone ? phone.trim() : null,
        email: email ? email.trim() : null,
        address: address ? address.trim() : null,
      },
    })
    res.json(client)
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
})

// DELETE /api/clients/:id — удалить клиента
router.delete('/:id', async (req, res) => {
  try {
    // Проверим, есть ли ведомости у клиента
    const count = await prisma.vedomost.count({
      where: { clientId: req.params.id },
    })

    if (count > 0) {
      return res.status(400).json({
        error: `Неможливо видалити: у клієнта ${count} відомостей`,
      })
    }

    await prisma.client.delete({
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