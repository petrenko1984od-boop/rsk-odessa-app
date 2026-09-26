import api from './client'

export const getClients = async () => {
  const response = await api.get('/clients')
  return response.data
}

export const getClient = async (id) => {
  const response = await api.get(`/clients/${id}`)
  return response.data
}

export const createClient = async (client) => {
  const response = await api.post('/clients', client)
  return response.data
}

export const updateClient = async (id, client) => {
  const response = await api.put(`/clients/${id}`, client)
  return response.data
}

export const deleteClient = async (id) => {
  const response = await api.delete(`/clients/${id}`)
  return response.data
}