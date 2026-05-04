import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'

const GALLERY = [
  {
    src: 'https://images.unsplash.com/photo-1500530855697-b586d89ba3ee?auto=format&fit=crop&w=1600&q=85',
    alt: 'Sunset over mountains',
  },
  {
    src: 'https://images.unsplash.com/photo-1441974231531-c6227db76b6e?auto=format&fit=crop&w=1600&q=85',
    alt: 'Forest path with sunlight',
  },
  {
    src: 'https://images.unsplash.com/photo-1452587925148-ce544e77e70d?auto=format&fit=crop&w=1600&q=85',
    alt: 'City lights at night',
  },
  {
    src: 'https://images.unsplash.com/photo-1473445361085-b9a07f55608b?auto=format&fit=crop&w=1600&q=85',
    alt: 'Minimal architecture',
  },
  {
    src: 'https://images.unsplash.com/photo-1516035069371-29a1b244cc32?auto=format&fit=crop&w=1600&q=85',
    alt: 'Camera lens close-up',
  },
  {
    src: 'https://images.unsplash.com/photo-1492691527719-9d1e07e534b4?auto=format&fit=crop&w=1600&q=85',
    alt: 'Mountain landscape',
  },
  {
    src: 'https://images.unsplash.com/photo-1502920917128-1aa500764cbd?auto=format&fit=crop&w=1600&q=85',
    alt: 'Portrait in natural light',
  },
  {
    src: 'https://images.unsplash.com/photo-1511895426328-dc8714191300?auto=format&fit=crop&w=1600&q=85',
    alt: 'Family walking outdoors',
  },
  {
    src: 'https://images.unsplash.com/photo-1524504388940-b1c1722653e1?auto=format&fit=crop&w=1600&q=85',
    alt: 'Studio portrait',
  },
  {
    src: 'https://images.unsplash.com/photo-1469474968028-56623f02e42e?auto=format&fit=crop&w=1600&q=85',
    alt: 'Misty sunrise over hills',
  },
  {
    src: 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?auto=format&fit=crop&w=1600&q=85',
    alt: 'Smiling portrait',
  },
  {
    src: 'https://images.unsplash.com/photo-1519741497674-611481863552?auto=format&fit=crop&w=1600&q=85',
    alt: 'Wedding couple',
  },
]

function BrowsePage() {
  const [lightboxIndex, setLightboxIndex] = useState(null)

  const closeLightbox = useCallback(() => {
    setLightboxIndex(null)
  }, [])

  const goPrev = useCallback(() => {
    setLightboxIndex((i) =>
      i === null ? null : (i - 1 + GALLERY.length) % GALLERY.length,
    )
  }, [])

  const goNext = useCallback(() => {
    setLightboxIndex((i) => (i === null ? null : (i + 1) % GALLERY.length))
  }, [])

  useEffect(() => {
    if (lightboxIndex === null) return undefined

    const onKeyDown = (e) => {
      if (e.key === 'Escape') closeLightbox()
      if (e.key === 'ArrowLeft') {
        e.preventDefault()
        goPrev()
      }
      if (e.key === 'ArrowRight') {
        e.preventDefault()
        goNext()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    return () => {
      window.removeEventListener('keydown', onKeyDown)
      document.body.style.overflow = prev
    }
  }, [lightboxIndex, closeLightbox, goPrev, goNext])

  const active = lightboxIndex !== null ? GALLERY[lightboxIndex] : null

  return (
    <main className="min-h-screen bg-black text-white">
      <div className="mx-auto max-w-6xl px-4 py-8 md:px-6 md:py-10">
        <Link
          to="/"
          className="mb-8 inline-block text-sm font-medium tracking-wide text-zinc-300 transition hover:text-white"
        >
          Back to Home
        </Link>

        <h1 className="mb-8 text-3xl font-semibold tracking-tight md:text-4xl">Browse my work</h1>

        <div className="columns-1 gap-3 sm:columns-2 lg:columns-3">
          {GALLERY.map((photo, index) => (
            <button
              key={photo.src}
              type="button"
              onClick={() => setLightboxIndex(index)}
              className="mb-3 w-full break-inside-avoid overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-900 text-left outline-none ring-white/0 transition hover:border-zinc-600 focus-visible:ring-2 focus-visible:ring-white"
            >
              <img
                src={photo.src}
                alt={photo.alt}
                loading="lazy"
                className="w-full object-cover transition duration-300 ease-out hover:scale-[1.02]"
              />
            </button>
          ))}
        </div>
      </div>

      {active && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/90 p-4 md:p-8"
          role="dialog"
          aria-modal="true"
          aria-label="Enlarged photo"
          onClick={closeLightbox}
        >
          <button
            type="button"
            onClick={closeLightbox}
            className="absolute right-4 top-4 z-10 rounded-full bg-white/10 px-3 py-1.5 text-sm font-medium text-white backdrop-blur transition hover:bg-white/20"
          >
            Close
          </button>
          <div
            className="flex max-h-[90vh] w-full max-w-6xl items-center gap-2 md:gap-4"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              onClick={goPrev}
              aria-label="Previous photo"
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-white/10 text-white backdrop-blur transition hover:bg-white/20 md:h-12 md:w-12"
            >
              <svg className="h-6 w-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
              </svg>
            </button>
            <img
              src={active.src}
              alt={active.alt}
              className="max-h-[85vh] min-h-0 flex-1 rounded-lg object-contain shadow-2xl"
            />
            <button
              type="button"
              onClick={goNext}
              aria-label="Next photo"
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-white/10 text-white backdrop-blur transition hover:bg-white/20 md:h-12 md:w-12"
            >
              <svg className="h-6 w-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
              </svg>
            </button>
          </div>
        </div>
      )}
    </main>
  )
}

export default BrowsePage
