require('dotenv').config()
const express = require('express')
const cors = require('cors')
const path = require('path')
const prisma = require('./prisma')

const app = express()
const PORT = process.env.PORT || 3001

app.use(cors())
app.use(express.json())

app.get('/api/health', async (req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`
    res.json({ status: 'ok', database: 'connected' })
  } catch (error) {
    res.status(500).json({ status: 'error', message: error.message })
  }
})

const worksRouter = require('./routes/works')
app.use('/api/works', worksRouter)

const materialsRouter = require('./routes/materials')
app.use('/api/materials', materialsRouter)

const vedomostiRouter = require('./routes/vedomosti')
app.use('/api/vedomosti', vedomostiRouter)

const catalogSectionsRouter = require('./routes/catalog-sections')
app.use('/api/catalog-sections', catalogSectionsRouter)

const pdfRouter = require('./routes/pdf')
app.use('/api/pdf', pdfRouter)

const excelRouter = require('./routes/excel')
app.use('/api/excel', excelRouter)

const companySettingsRouter = require('./routes/company-settings')
app.use('/api/company-settings', companySettingsRouter)

const catalogUnitsRouter = require('./routes/catalog-units')
app.use('/api/catalog-units', catalogUnitsRouter)

const materialSectionsRouter = require('./routes/material-sections')
app.use('/api/material-sections', materialSectionsRouter)

const clientsRouter = require('./routes/clients')
app.use('/api/clients', clientsRouter)

app.use('/uploads', express.static(path.join(__dirname, '../uploads')))

app.listen(PORT, () => {
  console.log('Server started on http://localhost:' + PORT)
  console.log('Health check: http://localhost:' + PORT + '/api/health')
})