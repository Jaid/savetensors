import type {DownloaderOptions, OverwriteStrategy} from '#src/lib/types.ts'
import type command from './command.ts'
import type {CommandHandlerContext} from 'clerc'

import Downloader from '#src/Downloader.ts'

const overwriteStrategies = new Set(['error', 'keep', 'mismatch', 'skip', 'wipe'])
const arrayFlag = (value: unknown) => {
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === 'string')
  }
  if (typeof value === 'string') {
    return [value]
  }
  return []
}
const stringFlag = (value: unknown) => {
  return typeof value === 'string' && value ? value : undefined
}
const booleanFlag = (value: unknown) => {
  return value === true
}
const numberFlag = (value: unknown, fallback: number) => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }
  if (typeof value === 'string' && value) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) {
      return parsed
    }
  }
  return fallback
}
const overwriteStrategyFlag = (value: unknown): OverwriteStrategy => {
  const strategy = stringFlag(value) || 'mismatch'
  if (!overwriteStrategies.has(strategy)) {
    throw new Error(`Invalid overwrite strategy: ${strategy}. Expected one of ${[...overwriteStrategies].join(', ')}.`)
  }
  return strategy as OverwriteStrategy
}

export const run = async (context: CommandHandlerContext<typeof command>) => {
  const flags = context.flags as Record<string, unknown>
  const parameters = context.parameters as Record<string, unknown>
  const url = stringFlag(parameters.url) || stringFlag(flags.url) || stringFlag(flags.repo)
  if (!url) {
    throw new Error('No Hugging Face repository specified. Pass a slug/URL as the positional argument or via --url.')
  }
  const options: DownloaderOptions = {
    dump: booleanFlag(flags.dump),
    fancy: booleanFlag(flags.fancy),
    folder: stringFlag(flags.folder) || '{{owner}}/{{repo}}',
    jobs: numberFlag(flags.jobs, 4),
    mergeSplits: booleanFlag(flags.mergeSplits),
    omitFile: arrayFlag(flags.omitFile),
    omitFolder: arrayFlag(flags.omitFolder),
    omitPattern: arrayFlag(flags.omitPattern),
    omitStem: arrayFlag(flags.omitStem),
    omitSuffix: arrayFlag(flags.omitSuffix),
    onlyFile: arrayFlag(flags.onlyFile),
    onlyFolder: arrayFlag(flags.onlyFolder),
    onlyPattern: arrayFlag(flags.onlyPattern),
    onlyStem: arrayFlag(flags.onlyStem),
    onlySuffix: arrayFlag(flags.onlySuffix),
    overwriteStrategy: overwriteStrategyFlag(flags.overwriteStrategy),
    partialFolder: stringFlag(flags.partialFolder) ?? '{{outputFolder}}/.partial',
    pedantic: booleanFlag(flags.pedantic),
    revision: stringFlag(flags.revision) || stringFlag(flags.ref),
    token: stringFlag(flags.token),
    url,
  }
  await new Downloader(options).run()
}
