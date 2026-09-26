import api from './client'

export const getCompanySettings = async () => {
  const response = await api.get('/company-settings')
  return response.data
}

export const updateCompanySettings = async (settings) => {
  const response = await api.put('/company-settings', settings)
  return response.data
}

export const uploadLogo = async (file) => {
  const formData = new FormData()
  formData.append('logo', file)
  const response = await api.post('/company-settings/logo', formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
  })
  return response.data
}

export const deleteLogo = async () => {
  const response = await api.delete('/company-settings/logo')
  return response.data
}