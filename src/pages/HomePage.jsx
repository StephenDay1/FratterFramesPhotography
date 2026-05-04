import { useEffect } from 'react'
import { Link } from 'react-router-dom'

function HomePage() {
  useEffect(() => {
    const previousHtmlOverflow = document.documentElement.style.overflow
    const previousBodyOverflow = document.body.style.overflow
    const mediaQuery = window.matchMedia('(min-width: 768px)')

    const applyScrollLock = () => {
      if (mediaQuery.matches) {
        document.documentElement.style.overflow = 'hidden'
        document.body.style.overflow = 'hidden'
      } else {
        document.documentElement.style.overflow = previousHtmlOverflow
        document.body.style.overflow = previousBodyOverflow
      }
    }

    applyScrollLock()
    mediaQuery.addEventListener('change', applyScrollLock)

    return () => {
      mediaQuery.removeEventListener('change', applyScrollLock)
      document.documentElement.style.overflow = previousHtmlOverflow
      document.body.style.overflow = previousBodyOverflow
    }
  }, [])

  const tiles = [
    {
      type: 'title',
      title: 'Fratter Frames Photography',
      className: 'md:col-start-3 md:col-span-2 md:row-start-3 md:row-span-1',
    },
    {
      src: 'https://images.unsplash.com/photo-1500530855697-b586d89ba3ee?auto=format&fit=crop&w=900&q=80',
      alt: 'Sunset mountains',
      coverText: 'Gallery',
      redirectUrl: '/gallery',
      className: 'md:col-start-4 md:col-span-2 md:row-start-1 md:row-span-2',
    },
    {
      src: 'https://images.unsplash.com/photo-1441974231531-c6227db76b6e?auto=format&fit=crop&w=900&q=80',
      alt: 'Forest trail',
      coverText: 'Family Photos',
      redirectUrl: '/family-photos',
      mobileHalf: true,
      className: 'md:col-start-1 md:col-span-3 md:row-start-1 md:row-span-2',
    },
    {
      src: 'https://images.unsplash.com/photo-1452587925148-ce544e77e70d?auto=format&fit=crop&w=900&q=80',
      alt: 'City lights',
      coverText: 'Portraits',
      redirectUrl: '/portraits',
      mobileHalf: true,
      className: 'md:col-start-6 md:col-span-2 md:row-start-1 md:row-span-3',
    },
    {
      src: 'https://images.unsplash.com/photo-1519389950473-47ba0277781c?auto=format&fit=crop&w=900&q=80',
      alt: 'Instagram',
      coverText: 'Instagram',
      redirectUrl: 'https://www.instagram.com/fratter.frame.photography?igsh=M2Q4djd4OXg0Y3Ro',
      mobileHalf: true,
      className: 'md:col-start-6 md:col-span-2 md:row-start-4 md:row-span-1',
    },
    {
      src: 'https://images.unsplash.com/photo-1473445361085-b9a07f55608b?auto=format&fit=crop&w=900&q=80',
      alt: 'Minimal architecture',
      coverText: 'About Fratter Frames',
      redirectUrl: '/about-me',
      mobileHalf: true,
      className: 'md:col-start-1 md:col-span-2 md:row-start-3 md:row-span-2',
    },
    {
      src: 'https://images.unsplash.com/photo-1516035069371-29a1b244cc32?auto=format&fit=crop&w=900&q=80',
      alt: 'Lens closeup',
      coverText: 'Pricing',
      redirectUrl: '/pricing',
      mobileHalf: true,
      className: 'md:col-start-5 md:col-span-1 md:row-start-3 md:row-span-2',
    },
    {
      src: 'https://images.unsplash.com/photo-1519389950473-47ba0277781c?auto=format&fit=crop&w=900&q=80',
      alt: 'Studio setup',
      coverText: 'Contact Me',
      mobileHalf: true,
      className: 'md:col-start-3 md:col-span-2 md:row-start-4 md:row-span-1',
    },
  ]

  return (
    <main className="min-h-screen bg-black text-white md:h-screen md:overflow-hidden">
      <div className="mx-auto px-4 py-6 md:h-full md:overflow-hidden md:px-6 md:py-8">
        <section className="grid auto-rows-[220px] grid-cols-2 gap-3 md:h-full md:grid-cols-7 md:grid-rows-[repeat(4,minmax(0,1fr))] md:gap-4">
          {tiles.map((tile, index) => (
            <article
              key={tile.type === 'title' ? 'title-tile' : `${tile.src ?? tile.type}-${index}`}
              className={`relative ${tile.mobileHalf ? 'col-span-1' : 'col-span-2'} overflow-hidden rounded-2xl md:min-h-0 ${tile.coverText ? 'group' : ''} ${tile.className}`}
            >
              {tile.type === 'title' ? (
                <div className="flex h-full items-center justify-center bg-zinc-900 p-6">
                  <h1 className="w-full text-center text-xl font-semibold tracking-tight md:text-2xl">
                    {tile.title}
                  </h1>
                </div>
              ) : (
                <>
                  <img
                    className={`h-full w-full object-cover ${tile.coverText ? 'transition-transform duration-300 ease-out group-hover:scale-105' : ''}`}
                    src={tile.src}
                    alt={tile.alt}
                    loading="lazy"
                  />
                  {tile.coverText && (
                    <Link
                      to={tile.redirectUrl}
                      className="absolute inset-0 flex items-center justify-center bg-black/45 p-4 text-center text-lg font-semibold tracking-tight text-white"
                    >
                      {tile.coverText}
                    </Link>
                  )}
                </>
              )}
            </article>
          ))}
        </section>
      </div>
    </main>
  )
}

export default HomePage
