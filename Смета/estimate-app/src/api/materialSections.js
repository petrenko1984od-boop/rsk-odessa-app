import api from './client'

export const getMaterialSections = async (params = {}) => {
  const response = await api.get('/material-sections', { params })
  return response.data
}

export const getMaterialSectionsTree = async () => {
  const response = await api.get('/material-sections', { params: { tree: 'true' } })
  return response.data
}

export const createMaterialSection = async (section) => {
  const response = await api.post('/material-sections', section)
  return response.data
}

export const updateMaterialSection = async (id, section) => {
  const response = await api.put(`/material-sections/${id}`, section)
  return response.data
}

export const deleteMaterialSection = async (id) => {
  const response = await api.delete(`/material-sections/${id}`)
  return response.data
}