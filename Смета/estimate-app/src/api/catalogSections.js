import api from './client'

export const getSections = async (params = {}) => {
  const response = await api.get('/catalog-sections', { params })
  return response.data
}

export const getSectionsTree = async () => {
  const response = await api.get('/catalog-sections', { params: { tree: 'true' } })
  return response.data
}

export const createSection = async (section) => {
  const response = await api.post('/catalog-sections', section)
  return response.data
}

export const updateSection = async (id, section) => {
  const response = await api.put(`/catalog-sections/${id}`, section)
  return response.data
}

export const deleteSection = async (id) => {
  const response = await api.delete(`/catalog-sections/${id}`)
  return response.data
}