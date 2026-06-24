import type {DownloaderOptions, OverwriteStrategy} from '#src/lib/types.ts'
import type command from './command.ts'
import type {CommandHandlerContext} from 'clerc'

import Downloader from '#src/Downloader.ts'

const overwriteStrategies = new Set(['error', 'keep', 'mismatch', 'skip', 'wipe'])
const sourceFlagNames = new Set(['repo', 'url'])
const valueFlagNames = new Set([
  'base-folder',
  'baseFolder',
  'folder',
  'omit-file',
  'omit-folder',
  'omit-pattern',
  'omit-stem',
  'omit-suffix',
  'omitFile',
  'omitFolder',
  'omitPattern',
  'omitStem',
  'omitSuffix',
  'only-file',
  'only-folder',
  'only-pattern',
  'only-stem',
  'only-suffix',
  'onlyFile',
  'onlyFolder',
  'onlyPattern',
  'onlyStem',
  'onlySuffix',
  'overwrite-strategy',
  'overwriteStrategy',
  'partial-folder',
  'partialFolder',
  'ref',
  'repo',
  'revision',
  'token',
  'url',
])
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
const overwriteStrategyFlag = (value: unknown): OverwriteStrategy => {
  const strategy = stringFlag(value) || 'mismatch'
  if (!overwriteStrategies.has(strategy)) {
    throw new Error(`Invalid overwrite strategy: ${strategy}. Expected one of ${[...overwriteStrategies].join(', ')}.`)
  }
  return strategy as OverwriteStrategy
}
const splitLongFlag = (arg: string) => {
  const body = arg.slice(2)
  const separators = ['=', ':']
  let separatorIndex = -1
  for (const separator of separators) {
    const index = body.indexOf(separator)
    if (index !== -1 && (separatorIndex === -1 || index < separatorIndex)) {
      separatorIndex = index
    }
  }
  if (separatorIndex === -1) {
    return {
      name: body,
    }
  }
  return {
    name: body.slice(0, separatorIndex),
    value: body.slice(separatorIndex + 1),
  }
}
const isAsciiLetter = (char: string) => {
  const code = char.codePointAt(0) || 0
  return code >= 65 && code <= 90 || code >= 97 && code <= 122
}
const isFlagLike = (arg: string) => {
  if (!arg.startsWith('-') || arg.length < 2) {
    return false
  }
  if (isAsciiLetter(arg[1])) {
    return true
  }
  return arg.startsWith('--') && arg.length > 2 && isAsciiLetter(arg[2])
}
export const collectSourceUrls = (rawArgs: Array<string>) => {
  const urls: Array<string> = []
  for (let index = 0; index < rawArgs.length; index++) {
    const arg = rawArgs[index]
    if (!arg) {
      continue
    }
    if (arg === '--') {
      break
    }
    if (!isFlagLike(arg)) {
      urls.push(arg)
      continue
    }
    if (!arg.startsWith('--')) {
      continue
    }
    const flag = splitLongFlag(arg)
    if (sourceFlagNames.has(flag.name)) {
      if (flag.value !== undefined) {
        urls.push(flag.value)
        continue
      }
      const next = rawArgs[index + 1]
      if (next && !isFlagLike(next)) {
        urls.push(next)
        index++
      }
      continue
    }
    if (valueFlagNames.has(flag.name) && flag.value === undefined) {
      const next = rawArgs[index + 1]
      if (next && !isFlagLike(next)) {
        index++
      }
    }
  }
  return urls.filter(url => url.length > 0)
}
const collectFallbackUrls = (parameters: Record<string, unknown>, flags: Record<string, unknown>) => {
  return [
    ...arrayFlag(parameters.url),
    ...arrayFlag(flags.url),
    ...arrayFlag(flags.repo),
  ]
}
const makeOptions = (flags: Record<string, unknown>, url: string): DownloaderOptions => {
  return {
    baseFolder: stringFlag(flags.baseFolder),
    dump: booleanFlag(flags.dump),
    eagerSkip: booleanFlag(flags.eagerSkip),
    fancy: booleanFlag(flags.fancy),
    folder: stringFlag(flags.folder) || '{{owner}}/{{repo}}',
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
}

export const run = async (context: CommandHandlerContext<typeof command>) => {
  const flags = context.flags as Record<string, unknown>
  const parameters = context.parameters as Record<string, unknown>
  const rawUrls = collectSourceUrls(context.rawParsed.raw)
  const urls = rawUrls.length > 0 ? rawUrls : collectFallbackUrls(parameters, flags)
  if (urls.length === 0) {
    throw new Error('No Hugging Face repository specified. Pass a slug/URL as the positional argument or via --url.')
  }
  const options = urls.map(url => makeOptions(flags, url))
  if (booleanFlag(flags.dump) && options.length > 1) {
    const outputs = []
    for (const option of options) {
      outputs.push(await new Downloader(option).dump())
    }
    console.log(JSON.stringify(outputs, null, 2))
    return outputs
  }
  const outputs = []
  for (const option of options) {
    outputs.push(await new Downloader(option).run())
  }
  return outputs
}
