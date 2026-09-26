import api from './client'

export const getWorks = async (sectionId = null) => {
  const url = sectionId ? `/works?sectionId=${sectionId}` : '/works'
  const response = await api.get(url)
  return response.data
}

export const createWork = async (work) => {
  const response = await api.post('/works', work)
  return response.data
}

export const updateWork = async (id, work) => {
  const response = await api.put(`/works/${id}`, work)
  return response.data
}

export const deleteWork = async (id) => {
  const response = await api.delete(`/works/${id}`)
  return response.data
}

export const linkMaterialToWork = async (workId, materialId, consumption) => {
  const response = await api.post(`/works/${workId}/materials`, {
    materialId,
    consumption,
  })
  return response.data
}

export const updateMaterialConsumption = async (workId, linkId, consumption) => {
  const response = await api.put(`/works/${workId}/materials/${linkId}`, {
    consumption,
  })
  return response.data
}

export const unlinkMaterialFromWork = async (workId, linkId) => {
  const response = await api.delete(`/works/${workId}/materials/${linkId}`)
  return response.data
}