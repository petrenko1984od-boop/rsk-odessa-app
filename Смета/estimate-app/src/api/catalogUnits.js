import api from './client'

export const getUnits = async () => {
  const response = await api.get('/catalog-units')
  return response.data
}

export const createUnit = async (unit) => {
  const response = await api.post('/catalog-units', unit)
  return response.data
}

export const updateUnit = async (id, unit) => {
  const response = await api.put(`/catalog-units/${id}`, unit)
  return response.data
}

export const deleteUnit = async (id) => {
  const response = await api.delete(`/catalog-units/${id}`)
  return response.data
}