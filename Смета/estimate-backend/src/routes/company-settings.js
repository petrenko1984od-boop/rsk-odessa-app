const express = require('express')
const router = express.Router()
const multer = require('multer')
const path = require('path')
const fs = require('fs')
const prisma = require('../prisma')

// Настройка multer для загрузки логотипа
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join(__dirname, '../../uploads')
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true })
    }
    cb(null, uploadDir)
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase()
    const filename = `logo-${Date.now()}${ext}`
    cb(null, filename)
  },
})

const upload = multer({
  storage,
  limits: { fileSize: 2 * 1024 * 1024 }, // 2 MB
  fileFilter: (req, file, cb) => {
    const allowed = ['.png', '.jpg', '.jpeg']
    const ext = path.extname(file.originalname).toLowerCase()
    if (allowed.includes(ext)) {
      cb(null, true)
    } else {
      cb(new Error('Дозволені лише файли PNG, JPG, JPEG'))
    }
  },
})

// GET /api/company-settings — получить настройки компании
router.get('/', async (req, res) => {
  try {
    const userId = await getDefaultUserId()
    let settings = await prisma.companySettings.findUnique({
      where: { userId },
    })

    // Если настроек нет — создаём пустые
    if (!settings) {
      settings = await prisma.companySettings.create({
        data: { userId },
      })
    }

    res.json(settings)
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
})

// PUT /api/company-settings — обновить настройки
router.put('/', async (req, res) => {
  try {
    const userId = await getDefaultUserId()
    const {
      companyName,
      phone,
      email,
      website,
      address,
      defaultNotes,
    } = req.body

    const settings = await prisma.companySettings.upsert({
      where: { userId },
      update: {
        companyName: companyName || null,
        phone: phone || null,
        email: email || null,
        website: website || null,
        address: address || null,
        defaultNotes: defaultNotes || null,
      },
      create: {
        userId,
        companyName: companyName || null,
        phone: phone || null,
        email: email || null,
        website: website || null,
        address: address || null,
        defaultNotes: defaultNotes || null,
      },
    })

    res.json(settings)
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
})

// POST /api/company-settings/logo — загрузить логотип
router.post('/logo', upload.single('logo'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Файл не завантажено' })
    }

    const userId = await getDefaultUserId()
    const logoUrl = `/uploads/${req.file.filename}`

    // Удаляем старый логотип
    const existing = await prisma.companySettings.findUnique({
      where: { userId },
    })
    if (existing?.logoUrl) {
      const oldPath = path.join(__dirname, '../..', existing.logoUrl)
      if (fs.existsSync(oldPath)) {
        fs.unlinkSync(oldPath)
      }
    }

    const settings = await prisma.companySettings.upsert({
      where: { userId },
      update: { logoUrl },
      create: { userId, logoUrl },
    })

    res.json(settings)
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
})

// DELETE /api/company-settings/logo — удалить логотип
router.delete('/logo', async (req, res) => {
  try {
    const userId = await getDefaultUserId()

    const existing = await prisma.companySettings.findUnique({
      where: { userId },
    })

    if (existing?.logoUrl) {
      const oldPath = path.join(__dirname, '../..', existing.logoUrl)
      if (fs.existsSync(oldPath)) {
        fs.unlinkSync(oldPath)
      }
    }

    const settings = await prisma.companySettings.update({
      where: { userId },
      data: { logoUrl: null },
    })

    res.json(settings)
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