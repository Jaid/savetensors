import type {FilterMatchKind, FilterOptions, FilterResult, RemoteDirectory, RemoteFile} from './types.ts'
import type {ListFileEntry} from '@huggingface/hub'

import * as pathUtil from 'forward-slash-path'
import picomatch from 'picomatch'

const defaultSkipFiles = new Set([
  '.gitattributes',
  '.gitignore',
  '.gitkeep',
])
const defaultSkipPatterns = [
  /^copying(?:[-._].*)?$/iu,
  /^copyright(?:[-._].*)?$/iu,
  /^license(?:[-._].*)?$/iu,
  /^licen[cs]e(?:[-._].*)?$/iu,
  /^notice(?:[-._].*)?$/iu,
  /^unlicense(?:[-._].*)?$/iu,
]

type PathInfo = {
  basename: string
  extension: string
  folders: Array<string>
  path: string
  stem: string
}

type MatchResult = {
  kind: FilterMatchKind
  value: string
}

const getPathInfo = (repoPath: string, isDirectory = false): PathInfo => {
  const basename = pathUtil.basename(repoPath)
  const extension = isDirectory ? '' : pathUtil.extname(repoPath).replace(/^\./u, '').toLowerCase()
  return {
    basename,
    extension,
    folders: repoPath.split('/').filter(Boolean).slice(0, isDirectory ? undefined : -1),
    path: repoPath,
    stem: isDirectory ? basename : pathUtil.stem(basename),
  }
}
const normalizeSuffixes = (suffixes: Array<string>) => {
  return suffixes.map(suffix => suffix.replace(/^\./u, '').toLowerCase())
}
const makeMatchers = (patterns: Array<string>) => {
  return patterns.map(pattern => ({
    matcher: picomatch(pattern, {dot: true}),
    pattern,
  }))
}
const findDefaultSkip = (info: PathInfo): MatchResult | undefined => {
  if (defaultSkipFiles.has(info.basename)) {
    return {
      kind: 'default',
      value: info.basename,
    }
  }
  const matchingPattern = defaultSkipPatterns.find(pattern => pattern.test(info.basename))
  if (matchingPattern) {
    return {
      kind: 'default',
      value: info.basename,
    }
  }
}
const findOmitMatch = (info: PathInfo, options: FilterOptions): MatchResult | undefined => {
  const omitSuffix = normalizeSuffixes(options.omitSuffix)
  if (options.omitFile.includes(info.basename)) {
    return {
      kind: 'omitFile',
      value: info.basename,
    }
  }
  const omittedFolder = options.omitFolder.find(folder => info.folders.includes(folder) || info.basename === folder)
  if (omittedFolder) {
    return {
      kind: 'omitFolder',
      value: omittedFolder,
    }
  }
  const pattern = makeMatchers(options.omitPattern).find(({matcher}) => matcher(info.path))?.pattern
  if (pattern) {
    return {
      kind: 'omitPattern',
      value: pattern,
    }
  }
  if (options.omitStem.includes(info.stem)) {
    return {
      kind: 'omitStem',
      value: info.stem,
    }
  }
  if (info.extension && omitSuffix.includes(info.extension)) {
    return {
      kind: 'omitSuffix',
      value: info.extension,
    }
  }
}

export const hasOnlyFilters = (options: FilterOptions) => {
  return options.onlyFile.length > 0 || options.onlyFolder.length > 0 || options.onlyPattern.length > 0 || options.onlyStem.length > 0 || options.onlySuffix.length > 0
}

export const findOnlyMatch = (info: PathInfo, options: FilterOptions): MatchResult | undefined => {
  const onlySuffix = normalizeSuffixes(options.onlySuffix)
  if (options.onlyFile.includes(info.basename)) {
    return {
      kind: 'onlyFile',
      value: info.basename,
    }
  }
  const requiredFolder = options.onlyFolder.find(folder => info.folders.includes(folder) || info.basename === folder)
  if (requiredFolder) {
    return {
      kind: 'onlyFolder',
      value: requiredFolder,
    }
  }
  const pattern = makeMatchers(options.onlyPattern).find(({matcher}) => matcher(info.path))?.pattern
  if (pattern) {
    return {
      kind: 'onlyPattern',
      value: pattern,
    }
  }
  if (options.onlyStem.includes(info.stem)) {
    return {
      kind: 'onlyStem',
      value: info.stem,
    }
  }
  if (info.extension && onlySuffix.includes(info.extension)) {
    return {
      kind: 'onlySuffix',
      value: info.extension,
    }
  }
}

export const describeMatch = (match: MatchResult) => {
  if (match.kind === 'default') {
    return `default skip: ${match.value}`
  }
  return `--${match.kind.replaceAll(/[A-Z]/gu, letter => `-${letter.toLowerCase()}`)} ${match.value}`
}

export const shouldIncludePath = (repoPath: string, options: FilterOptions, file = true, forcedPath?: string) => {
  const info = getPathInfo(repoPath, !file)
  const forced = forcedPath === repoPath
  if (file && forcedPath && !forced) {
    return {
      include: false,
      reason: 'not the forced file from URL',
    } as const
  }
  const onlyMatch = findOnlyMatch(info, options)
  if (hasOnlyFilters(options) && !onlyMatch && !forced) {
    return {
      include: false,
      reason: 'not matched by any --only-* filter',
    } as const
  }
  const omitMatch = findOmitMatch(info, options)
  if (omitMatch) {
    return {
      include: false,
      reason: describeMatch(omitMatch),
    } as const
  }
  const defaultSkip = !options.pedantic && !onlyMatch && !forced ? findDefaultSkip(info) : undefined
  if (defaultSkip) {
    return {
      include: false,
      reason: describeMatch(defaultSkip),
    } as const
  }
  let reason: string | undefined
  if (onlyMatch) {
    reason = describeMatch(onlyMatch)
  } else if (forced) {
    reason = 'forced by URL'
  }
  return {
    include: true,
    reason,
  } as const
}

export const filterEntries = (entries: Array<ListFileEntry>, options: FilterOptions, forcedPath?: string): FilterResult => {
  const files: Array<RemoteFile> = []
  const includedDirectories: Array<RemoteDirectory> = []
  const excluded: FilterResult['excluded'] = []
  for (const entry of entries) {
    if (entry.type === 'file') {
      const result = shouldIncludePath(entry.path, options, true, forcedPath)
      if (result.include) {
        files.push(entry as RemoteFile)
      } else {
        excluded.push({
          entry,
          reason: result.reason,
        })
      }
      continue
    }
    if (entry.type === 'directory') {
      const result = shouldIncludePath(entry.path, options, false)
      if (options.pedantic && result.include) {
        includedDirectories.push(entry as RemoteDirectory)
      } else if (!result.include) {
        excluded.push({
          entry,
          reason: result.reason,
        })
      }
      continue
    }
    excluded.push({
      entry,
      reason: 'unknown entry type',
    })
  }
  if (forcedPath && !files.some(file => file.path === forcedPath)) {
    const listedForcedEntry = entries.find(entry => entry.type === 'file' && entry.path === forcedPath)
    if (!listedForcedEntry) {
      throw new Error(`Forced file path from URL does not exist in repository listing: ${forcedPath}`)
    }
  }
  return {
    excluded,
    files,
    forcedPath,
    includedDirectories,
  }
}
