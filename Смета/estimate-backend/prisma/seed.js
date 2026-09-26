const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient()

const UNITS = [
  { name: 'м²', fullName: 'метр квадратний', order: 1 },
  { name: 'м³', fullName: 'метр кубічний', order: 2 },
  { name: 'м.п.', fullName: 'метр погонний', order: 3 },
  { name: 'шт', fullName: 'штука', order: 4 },
  { name: 'кг', fullName: 'кілограм', order: 5 },
  { name: 'т', fullName: 'тонна', order: 6 },
  { name: 'л', fullName: 'літр', order: 7 },
  { name: 'год', fullName: 'година', order: 8 },
  { name: 'люд.-год', fullName: 'людино-година', order: 9 },
  { name: 'люд.-день', fullName: 'людино-день', order: 10 },
  { name: 'комплект', fullName: 'комплект', order: 11 },
]

async function main() {
  console.log('Починаємо заповнення довідника одиниць виміру...')

  for (const unit of UNITS) {
    await prisma.catalogUnit.upsert({
      where: { name: unit.name },
      update: {
        fullName: unit.fullName,
        order: unit.order,
      },
      create: unit,
    })
  }

  console.log(`✔ Додано/оновлено ${UNITS.length} одиниць виміру`)
}

main()
  .catch((e) => {
    console.error('Помилка seed:', e)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })