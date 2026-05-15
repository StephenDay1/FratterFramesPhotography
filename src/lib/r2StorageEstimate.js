/** Cloudflare R2 Standard storage — see https://developers.cloudflare.com/r2/pricing/ */
export const R2_STANDARD_USD_PER_GB_MONTH = 0.015
export const R2_FREE_STORAGE_GB_MONTH = 10

export function bytesToGiB(bytes) {
  const value = Number(bytes) || 0
  return value / 1024 ** 3
}

/** Rough monthly storage charge (storage only; excludes operations and egress). */
export function estimateR2MonthlyStorageUsd(totalBytes) {
  const gib = bytesToGiB(totalBytes)
  const billableGiB = Math.max(0, gib - R2_FREE_STORAGE_GB_MONTH)
  return billableGiB * R2_STANDARD_USD_PER_GB_MONTH
}

export function formatUsd(amount) {
  const value = Number(amount) || 0
  if (value > 0 && value < 0.01) return '< $0.01'
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value)
}
