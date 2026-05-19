/**
 * Start a file download via a presigned GET URL (cross-origin; filename from Content-Disposition).
 * Does not fetch through JavaScript, so large files stream directly from R2.
 * @param {string} downloadUrl
 */
export function triggerPresignedBrowserDownload(downloadUrl) {
  if (!downloadUrl) return
  const a = document.createElement('a')
  a.href = downloadUrl
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  a.remove()
}
