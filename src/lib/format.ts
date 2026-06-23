export const renderTemplate = (template: string, context: Record<string, string | undefined>) => {
  return template.replaceAll(/\{\{\s*([\w\-.]+)\s*\}\}/gu, (match, key: string) => {
    const value = context[key]
    if (value === undefined) {
      throw new Error(`Unknown template variable: ${match}`)
    }
    return value
  })
}

export const formatBytes = (bytes: number) => {
  const units = ['b', 'kb', 'mb', 'gb', 'tb'] as const
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '0 b'
  }
  const unitIndex = Math.min(Math.floor(Math.log10(bytes) / 3), units.length - 1)
  const value = bytes / 1000 ** unitIndex
  let fractionDigits = 1
  if (unitIndex === 0) {
    fractionDigits = 0
  } else if (value < 10) {
    fractionDigits = 2
  }
  return `${value.toFixed(fractionDigits)} ${units[unitIndex]}`
}

export const formatDuration = (ms: number) => {
  if (ms < 1000) {
    return `${ms} ms`
  }
  if (ms < 60_000) {
    return `${(ms / 1000).toFixed(1)} s`
  }
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.floor(ms % 60_000 / 1000)
  return `${minutes} min ${String(seconds).padStart(2, '0')} s`
}
