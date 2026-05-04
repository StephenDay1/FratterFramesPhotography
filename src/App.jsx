import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import AboutMePage from './pages/AboutMePage'
import BrowsePage from './pages/BrowsePage'
import ContactMePage from './pages/ContactMePage'
import FamilyPhotosPage from './pages/FamilyPhotosPage'
import HomePage from './pages/HomePage'
import PortraitsPage from './pages/PortraitsPage'
import PricingPage from './pages/PricingPage'
import GalleriesHubPage from './pages/galleries/GalleriesHubPage'
import GalleryAdminPage from './pages/galleries/GalleryAdminPage'
import GalleryViewPage from './pages/galleries/GalleryViewPage'

function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/browse" element={<BrowsePage />} />
        <Route path="/family-photos" element={<FamilyPhotosPage />} />
        <Route path="/pricing" element={<PricingPage />} />
        <Route path="/about-me" element={<AboutMePage />} />
        <Route path="/portraits" element={<PortraitsPage />} />
        <Route path="/contact-me" element={<ContactMePage />} />
        <Route path="/galleries" element={<GalleriesHubPage />} />
        <Route path="/galleries/admin" element={<GalleryAdminPage />} />
        <Route path="/galleries/:galleryId" element={<GalleryViewPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  )
}

export default App
