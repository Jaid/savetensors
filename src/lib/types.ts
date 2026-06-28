import type {ListFileEntry, RepoDesignation, RepoType} from '@huggingface/hub'
import type {MergeTarget} from 'merge-safetensors'

export type {MergeRecord, MergeTarget} from 'merge-safetensors'

export type FilterMatchKind = 'default' | 'omitFile' | 'omitFolder' | 'omitPattern' | 'omitStem' | 'omitSuffix' | 'onlyFile' | 'onlyFolder' | 'onlyPattern' | 'onlyStem' | 'onlySuffix'
export type OverwriteStrategy = 'error' | 'keep' | 'mismatch' | 'skip' | 'wipe'
export type PlannedActionKind = 'download' | 'skip'

export type ParsedRepo = {
  forcedPath?: string
  name: string
  owner: string
  repo: RepoDesignation
  repoName: string
  revision?: string
  type: RepoType
}

export type TemplateContext = {
  home: string
  outputFolder?: string
  owner: string
  repo: string
  revision: string
  sourceDomain: string
  sourceId: string
  temp: string
}

export type FilterOptions = {
  omitFile: Array<string>
  omitFolder: Array<string>
  omitPattern: Array<string>
  omitStem: Array<string>
  omitSuffix: Array<string>
  onlyFile: Array<string>
  onlyFolder: Array<string>
  onlyPattern: Array<string>
  onlyStem: Array<string>
  onlySuffix: Array<string>
  pedantic: boolean
}

export type DownloaderOptions = FilterOptions & {
  baseFolder?: string
  dump: boolean
  eagerSkip: boolean
  fancy: boolean
  folder: string
  mergeSplits: boolean
  overwriteStrategy: OverwriteStrategy
  partialFolder: string
  revision?: string
  token?: string
  url: string
}

export type RemoteFile = ListFileEntry & {
  type: 'file'
}

export type RemoteDirectory = ListFileEntry & {
  type: 'directory'
}

export type ExcludedEntry = {
  entry: ListFileEntry
  reason: string
}

export type FilterResult = {
  excluded: Array<ExcludedEntry>
  files: Array<RemoteFile>
  forcedPath?: string
  includedDirectories: Array<RemoteDirectory>
}

export type PlannedAction = {
  file: RemoteFile
  kind: PlannedActionKind
  reason?: string
  targetPath: string
}

export type DownloadRecord = {
  durationMs?: number
  path: string
  reason?: string
  size: number
  status: 'downloaded' | 'error' | 'merged' | 'skipped'
  targetPath: string
}

export type DumpOutput = {
  context: {
    baseFolder?: string
    folder: string
    partialFolder: string
    repo: ParsedRepo
    tokenProvided: boolean
  }
  diagnostics: {
    actionCounts: Record<PlannedActionKind, number>
    directories: Array<string>
    eagerSkipped: boolean
    excluded: Array<{path: string
      reason: string
      type: ListFileEntry['type']}>
    included: Array<{path: string
      size: number
      targetPath: string}>
    listed: {
      directories: number
      files: number
      total: number
      unknown: number
    }
    mergeTargets: Array<MergeTarget>
    plannedActions: Array<{kind: PlannedActionKind
      path: string
      reason?: string
      targetPath: string}>
    totalBytes: number
  }
}
