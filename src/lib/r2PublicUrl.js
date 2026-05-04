/**
 * Builds a public object URL for R2 (or any HTTP origin) from an object key.
 * Configure VITE_R2_PUBLIC_BASE_URL with no trailing slash.
 */
export function r2PublicUrl(objectKey) {
  const base = import.meta.env.VITE_R2_PUBLIC_BASE_URL || ''
  if (!base || !objectKey) return ''
  const key = String(objectKey).replace(/^\/+/, '')
  return `${base.replace(/\/+$/, '')}/${key}`
}
