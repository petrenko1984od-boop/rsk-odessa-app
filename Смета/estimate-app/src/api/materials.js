import api from './client'

export const getMaterials = async (materialSectionId = null) => {
  const url = materialSectionId
    ? `/materials?sectionId=${materialSectionId}`
    : '/materials'
  const response = await api.get(url)
  return response.data
}

export const createMaterial = async (material) => {
  const response = await api.post('/materials', material)
  return response.data
}

export const updateMaterial = async (id, material) => {
  const response = await api.put(`/materials/${id}`, material)
  return response.data
}

export const deleteMaterial = async (id) => {
  const response = await api.delete(`/materials/${id}`)
  return response.data
}