import TransitionLink from '../components/TransitionLink'

function PageTemplate({ title, description, ctaLabel}) {
  return (
    <main className="min-h-screen bg-black text-white">
      <div className="mx-auto flex min-h-screen w-full max-w-4xl flex-col justify-center px-6 py-12">
        <TransitionLink
          to="/"
          className="mb-10 inline-block text-sm font-medium tracking-wide text-zinc-300 transition hover:text-white"
        >
          Back to Home
        </TransitionLink>

        <section className="rounded-2xl border border-zinc-800 bg-zinc-900/70 p-8 md:p-12">
          <h1 className="mb-4 text-3xl font-semibold tracking-tight md:text-4xl">
            {title}
          </h1>
          <p className="max-w-2xl text-base leading-relaxed text-zinc-300 md:text-lg">
            {description}
          </p>

          {ctaLabel && ctaLabel !== '' && <button
            type="button"
            className="mt-8 cursor-pointer rounded-xl bg-white px-5 py-2.5 text-sm font-semibold text-black transition hover:bg-zinc-200"
            >
              {ctaLabel}
            </button>
          }
        </section>
      </div>
    </main>
  )
}

export default PageTemplate
