import { createBrowserRouter, Navigate, RouterProvider } from 'react-router-dom'
import AboutMePage from './pages/AboutMePage'
import BrowsePage from './pages/BrowsePage'
import ContactMePage from './pages/ContactMePage'
import FamilyPhotosPage from './pages/FamilyPhotosPage'
import HomePage from './pages/HomePage'
import PortraitsPage from './pages/PortraitsPage'
import PricingPage from './pages/PricingPage'
import GalleriesHubPage from './pages/galleries/GalleriesLandingLoginPage'
import AdminLoginPage from './pages/galleries/AdminLoginPage'
import GalleryAdminPage from './pages/galleries/GalleryAdminPage'
import GalleryViewPage from './pages/galleries/GalleryViewPage'

const router = createBrowserRouter([
  { path: '/', element: <HomePage /> },
  { path: '/browse', element: <BrowsePage /> },
  { path: '/family-photos', element: <FamilyPhotosPage /> },
  { path: '/pricing', element: <PricingPage /> },
  { path: '/about-me', element: <AboutMePage /> },
  { path: '/portraits', element: <PortraitsPage /> },
  { path: '/contact-me', element: <ContactMePage /> },
  { path: '/galleries', element: <GalleriesHubPage /> },
  { path: '/admin', element: <AdminLoginPage /> },
  { path: '/galleries/admin', element: <GalleryAdminPage /> },
  { path: '/galleries/:galleryId', element: <GalleryViewPage /> },
  { path: '*', element: <Navigate to="/" replace /> },
])

function App() {
  return <RouterProvider router={router} />
}

export default App
