import { BrowserRouter, Routes, Route } from 'react-router-dom'
import Layout from './components/Layout'
import VedomostiList from './pages/VedomostiList'
import VedomostCreate from './pages/VedomostCreate'
import Clients from './pages/Clients'
import Catalog from './pages/Catalog'

function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Layout />}>
          <Route index element={<VedomostiList />} />
          <Route path="vedomosti/new" element={<VedomostCreate />} />
          <Route path="vedomosti/:id" element={<VedomostCreate />} />
          <Route path="clients" element={<Clients />} />
          <Route path="catalog" element={<Catalog />} />
        </Route>
      </Routes>
    </BrowserRouter>
  )
}

export default App