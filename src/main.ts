export {Downloader} from './Downloader.ts'
export {Downloader as default} from './Downloader.ts'
export {filterEntries, shouldIncludePath} from './lib/filter.ts'
export {findMergeTargets, mergeSplits, mergeTarget} from './lib/mergeSplits.ts'
export {parseRepo, repoDisplayName} from './lib/parseRepo.ts'

export type {DownloaderOptions, DownloadRecord, DumpOutput, MergeRecord, MergeTarget, OverwriteStrategy, ParsedRepo} from './lib/types.ts'
