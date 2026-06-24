import type {DownloaderOptions, DownloadRecord, DumpOutput, ParsedRepo, PlannedAction, RemoteFile, TemplateContext} from './lib/types.ts'
import type {ListFileEntry} from '@huggingface/hub'

import os from 'node:os'
import {Readable, Transform} from 'node:stream'
import {pipeline} from 'node:stream/promises'

import {downloadFile, listCommits, listFiles} from '@huggingface/hub'
import chalk from 'chalk'
import * as pathUtil from 'forward-slash-path'
import fs from 'fs-extra'
import {hashFile} from 'hasha'

import {filterEntries} from './lib/filter.ts'
import {formatBytes, formatDuration, renderTemplate} from './lib/format.ts'
import {findMergeTargets, mergeSplits} from './lib/mergeSplits.ts'
import {parseRepo, repoDisplayName} from './lib/parseRepo.ts'

const sourceDomain = 'huggingface.co'
const sourceId = 'hugging_face'
const defaultOptions = {
  dump: false,
  fancy: false,
  folder: '{{owner}}/{{repo}}',
  mergeSplits: false,
  omitFile: [],
  omitFolder: [],
  omitPattern: [],
  omitStem: [],
  omitSuffix: [],
  onlyFile: [],
  onlyFolder: [],
  onlyPattern: [],
  onlyStem: [],
  onlySuffix: [],
  overwriteStrategy: 'mismatch',
  partialFolder: '{{outputFolder}}/.partial',
  pedantic: false,
} satisfies Omit<DownloaderOptions, 'url'>

type PreparedSession = {
  entries: Array<ListFileEntry>
  filterResult: ReturnType<typeof filterEntries>
  outputFolder: string
  partialFolder: string
  plannedActions: Array<PlannedAction>
  repo: ParsedRepo
}

export class Downloader {
  readonly options: DownloaderOptions
  private lastRenderLength = 0
  private progress = {
    downloadedBytes: 0,
    downloadedFiles: 0,
    startedAt: 0,
    totalBytes: 0,
    totalFiles: 0,
  }

  constructor(options: DownloaderOptions | Partial<DownloaderOptions> & {url: string}) {
    this.options = {
      ...defaultOptions,
      ...options,
      token: options.token || Bun.env.HF_TOKEN,
    }
  }

  async dump() {
    const session = await this.prepare()
    return this.makeDump(session)
  }

  async run() {
    const session = await this.prepare()
    if (this.options.dump) {
      const output = await this.makeDump(session)
      console.log(JSON.stringify(output, null, 2))
      return output
    }
    return this.download(session)
  }

  private async download(session: PreparedSession) {
    if (this.options.overwriteStrategy === 'wipe') {
      await fs.emptyDir(session.outputFolder)
    } else {
      await fs.ensureDir(session.outputFolder)
    }
    await this.ensureDirectories(session)
    const downloads = session.plannedActions.filter(action => action.kind === 'download')
    this.startProgress(downloads)
    const records: Array<DownloadRecord> = []
    for (const action of session.plannedActions) {
      if (action.kind === 'skip') {
        this.progress.downloadedFiles++
        records.push({
          path: action.file.path,
          reason: action.reason,
          size: this.entrySize(action.file),
          status: 'skipped',
          targetPath: action.targetPath,
        })
        continue
      }
      records.push(await this.downloadAction(action, session))
    }
    if (session.partialFolder) {
      await fs.remove(session.partialFolder)
    }
    const mergeRecords = this.options.mergeSplits ? await this.merge(session.outputFolder, records) : []
    this.finishProgress(records, mergeRecords.length)
    return {
      downloads: records,
      merges: mergeRecords,
    }
  }

  private async downloadAction(action: PlannedAction, session: PreparedSession): Promise<DownloadRecord> {
    const startedAt = Date.now()
    const size = this.entrySize(action.file)
    if (!this.options.fancy) {
      const kept = action.reason ? ` ${chalk.gray(`(${action.reason})`)}` : ''
      console.log(`${chalk.gray('↓')} ${action.file.path} ${chalk.gray(formatBytes(size))}${kept}`)
    }
    const partialPath = session.partialFolder ? pathUtil.join(session.partialFolder, action.file.path) : `${action.targetPath}.partial`
    try {
      await this.streamFile(action.file, partialPath, session.repo, downloadedBytes => this.reportProgress(action.file.path, downloadedBytes, size))
      await fs.ensureDir(pathUtil.dirname(action.targetPath))
      await fs.move(partialPath, action.targetPath, {overwrite: true})
      this.progress.downloadedBytes += size
      this.progress.downloadedFiles++
      const record = {
        durationMs: Date.now() - startedAt,
        path: action.file.path,
        size,
        status: 'downloaded',
        targetPath: action.targetPath,
      } satisfies DownloadRecord
      if (!this.options.fancy) {
        console.log(`${chalk.green('✓')} ${action.file.path} ${chalk.gray(formatDuration(record.durationMs))}`)
      }
      return record
    } catch (error) {
      await fs.remove(partialPath).catch(() => {})
      throw new Error(`Failed to download ${action.file.path}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private async ensureDirectories(session: PreparedSession) {
    for (const directory of session.filterResult.includedDirectories) {
      await fs.ensureDir(pathUtil.join(session.outputFolder, directory.path))
    }
    for (const action of session.plannedActions) {
      await fs.ensureDir(pathUtil.dirname(action.targetPath))
    }
    if (session.partialFolder) {
      await fs.ensureDir(session.partialFolder)
    }
  }

  private entrySize(file: RemoteFile) {
    return file.lfs?.size ?? file.size
  }

  private async fileMatches(targetPath: string, file: RemoteFile) {
    const stat = await fs.stat(targetPath)
    const remoteSize = this.entrySize(file)
    if (stat.size !== remoteSize) {
      return false
    }
    const expectedSha256 = file.lfs?.oid || file.xetHash
    if (!expectedSha256) {
      return true
    }
    const localSha256 = await hashFile(targetPath, {algorithm: 'sha256'})
    return localSha256 === expectedSha256
  }

  private async findUnoccupiedPath(targetPath: string) {
    const parsed = pathUtil.parse(targetPath)
    for (let suffix = 2; suffix < 1_000_000; suffix++) {
      const candidate = pathUtil.format({
        dir: parsed.dir,
        ext: parsed.ext,
        name: `${parsed.name}_${suffix}`,
      })
      if (!await fs.pathExists(candidate)) {
        return candidate
      }
    }
    throw new Error(`Could not find an unoccupied target path for ${targetPath}.`)
  }

  private finishProgress(records: Array<DownloadRecord>, mergeCount: number) {
    if (this.options.fancy) {
      process.stderr.write('\n')
      process.stdout.write('\u001B]9;4;0;100\u0007')
      process.title = 'savetensors'
    }
    const downloaded = records.filter(record => record.status === 'downloaded')
    const skipped = records.filter(record => record.status === 'skipped')
    const elapsed = Date.now() - this.progress.startedAt
    console.log(`${chalk.green('✓')} ${downloaded.length} downloaded, ${skipped.length} skipped, ${mergeCount} merged in ${formatDuration(elapsed)}.`)
  }

  private async listRepositoryEntries(repo: ParsedRepo) {
    const entries: Array<ListFileEntry> = []
    for await (const entry of listFiles({
      accessToken: this.options.token,
      recursive: true,
      repo: repo.repo,
      revision: repo.revision,
    })) {
      entries.push(entry)
    }
    return entries
  }

  private async makeDump(session: PreparedSession): Promise<DumpOutput> {
    const listedFiles = session.entries.filter(entry => entry.type === 'file')
    const listedDirectories = session.entries.filter(entry => entry.type === 'directory')
    const listedUnknown = session.entries.filter(entry => entry.type === 'unknown')
    const mergeTargets = session.outputFolder ? await findMergeTargets(session.outputFolder).catch(() => []) : []
    const downloadableActions = session.plannedActions.filter(action => action.kind === 'download')
    return {
      context: {
        baseFolder: this.options.baseFolder,
        folder: session.outputFolder,
        partialFolder: session.partialFolder,
        repo: session.repo,
        tokenProvided: Boolean(this.options.token),
      },
      diagnostics: {
        actionCounts: {
          download: downloadableActions.length,
          skip: session.plannedActions.length - downloadableActions.length,
        },
        directories: session.filterResult.includedDirectories.map(directory => directory.path).toSorted((left, right) => left.localeCompare(right)),
        excluded: session.filterResult.excluded.map(({entry, reason}) => ({
          path: entry.path,
          reason,
          type: entry.type,
        })),
        included: session.plannedActions.map(action => ({
          path: action.file.path,
          size: this.entrySize(action.file),
          targetPath: action.targetPath,
        })),
        listed: {
          directories: listedDirectories.length,
          files: listedFiles.length,
          total: session.entries.length,
          unknown: listedUnknown.length,
        },
        mergeTargets,
        plannedActions: session.plannedActions.map(action => ({
          kind: action.kind,
          path: action.file.path,
          reason: action.reason,
          targetPath: action.targetPath,
        })),
        totalBytes: downloadableActions.reduce((sum, action) => sum + this.entrySize(action.file), 0),
      },
    }
  }

  private makeTemplateContext(repo: ParsedRepo, revision: string): TemplateContext {
    return {
      home: os.homedir(),
      owner: repo.owner,
      repo: repo.repoName,
      revision,
      sourceDomain,
      sourceId,
      temp: os.tmpdir(),
    }
  }

  private async merge(outputFolder: string, records: Array<DownloadRecord>) {
    const mergeRecords = await mergeSplits(outputFolder)
    const mergedFiles = new Set(mergeRecords.flatMap(record => [record.indexFile, ...record.shardFiles].filter(Boolean)))
    for (const record of records) {
      if (mergedFiles.has(record.targetPath)) {
        record.status = 'merged'
      }
    }
    for (const mergeRecord of mergeRecords) {
      console.log(`${chalk.green('✓')} merged ${mergeRecord.shardFiles.length} shards → ${pathUtil.relative(outputFolder, mergeRecord.outputFile)} ${chalk.gray(formatDuration(mergeRecord.durationMs))}`)
    }
    return mergeRecords
  }

  private async planDownloads(files: Array<RemoteFile>, outputFolder: string, readOnly = false) {
    const plannedActions: Array<PlannedAction> = []
    for (const file of files) {
      const targetPath = pathUtil.join(outputFolder, file.path)
      if (!await fs.pathExists(targetPath)) {
        plannedActions.push({
          file,
          kind: 'download',
          targetPath,
        })
        continue
      }
      if (this.options.overwriteStrategy === 'skip') {
        plannedActions.push({
          file,
          kind: 'skip',
          reason: 'target exists',
          targetPath,
        })
        continue
      }
      if (this.options.overwriteStrategy === 'error') {
        throw new Error(`Target file already exists: ${targetPath}`)
      }
      if (this.options.overwriteStrategy === 'keep') {
        plannedActions.push({
          file,
          kind: 'download',
          reason: 'keeping existing target',
          targetPath: await this.findUnoccupiedPath(targetPath),
        })
        continue
      }
      if (this.options.overwriteStrategy === 'mismatch') {
        if (await this.fileMatches(targetPath, file)) {
          plannedActions.push({
            file,
            kind: 'skip',
            reason: 'target already matches remote size/hash',
            targetPath,
          })
          continue
        }
        if (!readOnly) {
          await fs.remove(targetPath)
        }
      }
      plannedActions.push({
        file,
        kind: 'download',
        targetPath,
      })
    }
    return plannedActions
  }

  private async prepare(): Promise<PreparedSession> {
    const parsedRepo = parseRepo(this.options.url)
    const revision = this.options.revision || parsedRepo.revision || await this.resolveLatestRevision(parsedRepo)
    const repo = {
      ...parsedRepo,
      revision,
    }
    const context = this.makeTemplateContext(repo, revision)
    const outputFolder = this.resolveOutputFolder(context)
    const partialFolder = this.options.partialFolder ? pathUtil.resolve(renderTemplate(this.options.partialFolder, {
      ...context,
      outputFolder,
    })) : ''
    const entries = await this.listRepositoryEntries(repo)
    const filterResult = filterEntries(entries, this.options, repo.forcedPath)
    const plannedActions = await this.planDownloads(filterResult.files, outputFolder, this.options.dump)
    return {
      entries,
      filterResult,
      outputFolder,
      partialFolder,
      plannedActions,
      repo,
    }
  }

  private reportProgress(path: string, downloadedBytes: number, totalBytes: number) {
    if (!this.options.fancy) {
      return
    }
    const currentTotal = this.progress.downloadedBytes + downloadedBytes
    const percent = this.progress.totalBytes > 0 ? Math.min(100, currentTotal / this.progress.totalBytes * 100) : 100
    const barWidth = 26
    const filled = Math.round(percent / 100 * barWidth)
    const bar = `${chalk.cyan('█'.repeat(filled))}${chalk.gray('░'.repeat(barWidth - filled))}`
    const line = `${chalk.bold('↓')} ${bar} ${percent.toFixed(1).padStart(5)}% ${formatBytes(currentTotal)}/${formatBytes(this.progress.totalBytes)} ${chalk.dim(path)} ${chalk.gray(formatBytes(downloadedBytes))}/${chalk.gray(formatBytes(totalBytes))}`
    process.title = `savetensors ${percent.toFixed(0)}%`
    process.stderr.write(`\r${line}${' '.repeat(Math.max(0, this.lastRenderLength - line.length))}`)
    process.stdout.write(`\u001B]9;4;1;${Math.round(percent)}\u0007`)
    this.lastRenderLength = line.length
  }

  private async resolveLatestRevision(repo: ParsedRepo) {
    for await (const commit of listCommits({
      accessToken: this.options.token,
      repo: repo.repo,
    })) {
      return commit.oid
    }
    throw new Error(`Could not resolve latest revision for ${repoDisplayName(repo)}.`)
  }

  private resolveOutputFolder(context: TemplateContext) {
    const folder = renderTemplate(this.options.folder, context)
    if (!this.options.baseFolder) {
      return pathUtil.resolve(folder)
    }
    const baseFolder = pathUtil.resolve(renderTemplate(this.options.baseFolder, context))
    return pathUtil.resolve(baseFolder, folder)
  }

  private startProgress(actions: Array<PlannedAction>) {
    this.progress = {
      downloadedBytes: 0,
      downloadedFiles: 0,
      startedAt: Date.now(),
      totalBytes: actions.reduce((sum, action) => sum + this.entrySize(action.file), 0),
      totalFiles: actions.length,
    }
    if (!this.options.fancy) {
      console.log(chalk.gray(`Planning ${actions.length} downloads (${formatBytes(this.progress.totalBytes)}).`))
    }
  }

  private async streamFile(file: RemoteFile, targetPath: string, repo: ParsedRepo, onProgress: (downloadedBytes: number) => void) {
    await fs.ensureDir(pathUtil.dirname(targetPath))
    const blob = await downloadFile({
      accessToken: this.options.token,
      path: file.path,
      repo: repo.repo,
      revision: repo.revision,
    })
    if (!blob) {
      throw new Error('The Hugging Face API returned no blob.')
    }
    let downloadedBytes = 0
    const progressStream = new Transform({
      // eslint-disable-next-line promise/prefer-await-to-callbacks
      transform(chunk: Buffer, _encoding, callback) {
        downloadedBytes += chunk.length
        onProgress(downloadedBytes)
        // eslint-disable-next-line promise/prefer-await-to-callbacks
        callback(undefined, chunk)
      },
    })
    await pipeline(Readable.fromWeb(blob.stream() as ReadableStream<Uint8Array>), progressStream, fs.createWriteStream(targetPath))
  }
}

export default Downloader
