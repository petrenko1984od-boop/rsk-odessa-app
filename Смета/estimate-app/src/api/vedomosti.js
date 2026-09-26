import api from './client'

export const getVedomosti = async () => {
  const response = await api.get('/vedomosti')
  return response.data
}

export const getVedomost = async (id) => {
  const response = await api.get(`/vedomosti/${id}`)
  return response.data
}

export const createVedomost = async (vedomost) => {
  const response = await api.post('/vedomosti', vedomost)
  return response.data
}

export const updateVedomost = async (id, vedomost) => {
  const response = await api.put(`/vedomosti/${id}`, vedomost)
  return response.data
}

export const deleteVedomost = async (id) => {
  const response = await api.delete(`/vedomosti/${id}`)
  return response.data
}