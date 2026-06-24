import type {MergeRecord, MergeTarget} from './types.ts'

import * as pathUtil from 'forward-slash-path'
import fs from 'fs-extra'

const safetensorsIndexSuffix = '.safetensors.index.json'
const safetensorsShardPattern = /^(?<prefix>.+)-(?<part>\d{5})-of-(?<total>\d{5})\.safetensors$/u
const metadataKey = '__metadata__'
const copyBufferSize = 32 * 1024 * 1024
type FileHandle = Awaited<ReturnType<typeof fs.promises.open>>

type SafetensorsTensorHeader = {
  data_offsets: [number, number]
  dtype: string
  shape: Array<number>
}

type SafetensorsHeader = Record<string, Record<string, string> | SafetensorsTensorHeader | undefined>

type ParsedTensor = {
  dataLength: bigint
  dataStart: bigint
  dtype: string
  file: string
  name: string
  shape: Array<number>
}

type ParsedShard = {
  metadata?: Record<string, string>
  tensors: Array<ParsedTensor>
}

const collectFiles = async (folder: string): Promise<Array<string>> => {
  if (!await fs.pathExists(folder)) {
    return []
  }
  const entries = await fs.readdir(folder, {withFileTypes: true})
  const files: Array<string> = []
  for (const entry of entries) {
    const fullPath = pathUtil.join(folder, entry.name)
    if (entry.isDirectory()) {
      files.push(...await collectFiles(fullPath))
    } else if (entry.isFile()) {
      files.push(fullPath)
    }
  }
  return files
}
const unique = <Value>(values: Array<Value>) => {
  return [...new Set(values)]
}
const normalizeTarget = (target: MergeTarget): MergeTarget => {
  return {
    ...target,
    shardFiles: unique(target.shardFiles).toSorted((left, right) => left.localeCompare(right)),
  }
}
const findTargetsFromIndexes = async (files: Array<string>) => {
  const targets: Array<MergeTarget> = []
  for (const indexFile of files.filter(file => file.endsWith(safetensorsIndexSuffix))) {
    const index = await fs.readJson(indexFile).catch((error: unknown) => {
      throw new Error(`Could not read safetensors index ${indexFile}: ${error instanceof Error ? error.message : String(error)}`)
    }) as {weight_map?: Record<string, string>}
    if (!index.weight_map) {
      continue
    }
    const folder = pathUtil.dirname(indexFile)
    const shardFiles = unique(Object.values(index.weight_map)).map(file => pathUtil.join(folder, file))
    const outputFile = indexFile.slice(0, -'.index.json'.length)
    targets.push(normalizeTarget({
      indexFile,
      outputFile,
      shardFiles,
    }))
  }
  return targets
}
const findTargetsFromShardNames = (files: Array<string>, knownOutputFiles: Set<string>) => {
  const groups = new Map<string, Array<string>>
  for (const file of files) {
    const basename = pathUtil.basename(file)
    const match = safetensorsShardPattern.exec(basename)
    if (!match?.groups) {
      continue
    }
    const outputFile = pathUtil.join(pathUtil.dirname(file), `${match.groups.prefix}.safetensors`)
    if (knownOutputFiles.has(outputFile)) {
      continue
    }
    const group = groups.get(outputFile) ?? []
    group.push(file)
    groups.set(outputFile, group)
  }
  return [...groups.entries()]
    .filter(([, shardFiles]) => shardFiles.length > 1)
    .map(([outputFile, shardFiles]) => normalizeTarget({
      outputFile,
      shardFiles,
    }))
}

export const findMergeTargets = async (outputFolder: string) => {
  const files = await collectFiles(outputFolder)
  const indexTargets = await findTargetsFromIndexes(files)
  const knownOutputFiles = new Set(indexTargets.map(target => target.outputFile))
  return [...indexTargets, ...findTargetsFromShardNames(files, knownOutputFiles)]
}

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
const isMetadata = (value: unknown): value is Record<string, string> => {
  return isRecord(value) && Object.values(value).every(entry => typeof entry === 'string')
}
const isTensorHeader = (value: unknown): value is SafetensorsTensorHeader => {
  return isRecord(value)
    && typeof value.dtype === 'string'
    && Array.isArray(value.shape)
    && value.shape.every(dimension => Number.isSafeInteger(dimension) && dimension >= 0)
    && Array.isArray(value.data_offsets)
    && value.data_offsets.length === 2
    && value.data_offsets.every(offset => Number.isSafeInteger(offset) && offset >= 0)
}
const toSafeNumber = (value: bigint, label: string) => {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`${label} is too large for JavaScript’s safe integer range: ${value}.`)
  }
  return Number(value)
}
const readExactly = async (handle: FileHandle, buffer: Buffer, position: bigint, label: string) => {
  let readOffset = 0
  while (readOffset < buffer.length) {
    const {bytesRead} = await handle.read(buffer, readOffset, buffer.length - readOffset, toSafeNumber(position + BigInt(readOffset), label))
    if (bytesRead === 0) {
      throw new Error(`Unexpected end of file while reading ${label}.`)
    }
    readOffset += bytesRead
  }
}
const readSafetensorsHeader = async (file: string) => {
  const handle = await fs.promises.open(file, 'r')
  try {
    const stat = await handle.stat()
    const fileSize = BigInt(stat.size)
    if (fileSize < 8n) {
      throw new Error(`Safetensors file is too small to contain a header: ${file}.`)
    }
    const headerLengthBuffer = Buffer.allocUnsafe(8)
    await readExactly(handle, headerLengthBuffer, 0n, `${file} header length`)
    const headerLength = headerLengthBuffer.readBigUInt64LE()
    const dataStart = 8n + headerLength
    if (dataStart > fileSize) {
      throw new Error(`Safetensors header length exceeds file size for ${file}.`)
    }
    const headerBuffer = Buffer.alloc(toSafeNumber(headerLength, `${file} header length`))
    await readExactly(handle, headerBuffer, 8n, `${file} header`)
    const header = JSON.parse(headerBuffer.toString('utf8')) as SafetensorsHeader
    return {
      dataStart,
      fileSize,
      header,
    }
  } finally {
    await handle.close()
  }
}
const parseShard = async (file: string): Promise<ParsedShard> => {
  const {dataStart, fileSize, header} = await readSafetensorsHeader(file).catch((error: unknown) => {
    throw new Error(`Could not read safetensors shard ${file}: ${error instanceof Error ? error.message : String(error)}`)
  })
  const tensors: Array<ParsedTensor> = []
  for (const [name, entry] of Object.entries(header)) {
    if (name === metadataKey) {
      continue
    }
    if (!isTensorHeader(entry)) {
      throw new Error(`Invalid tensor header for ${name} in ${file}.`)
    }
    const [rawStart, rawEnd] = entry.data_offsets
    if (rawEnd < rawStart) {
      throw new Error(`Invalid tensor offsets for ${name} in ${file}: end is before start.`)
    }
    const start = BigInt(rawStart)
    const end = BigInt(rawEnd)
    const absoluteStart = dataStart + start
    const absoluteEnd = dataStart + end
    if (absoluteEnd > fileSize) {
      throw new Error(`Tensor ${name} in ${file} exceeds the shard file size.`)
    }
    tensors.push({
      dataLength: end - start,
      dataStart: absoluteStart,
      dtype: entry.dtype,
      file,
      name,
      shape: entry.shape,
    })
  }
  const rawMetadata = header[metadataKey]
  return {
    metadata: isMetadata(rawMetadata) ? rawMetadata : undefined,
    tensors,
  }
}
const makeMergedHeader = (tensors: Array<ParsedTensor>, metadata?: Record<string, string>) => {
  const header: SafetensorsHeader = {}
  if (metadata) {
    header[metadataKey] = metadata
  }
  let offset = 0n
  for (const tensor of tensors) {
    const nextOffset = offset + tensor.dataLength
    header[tensor.name] = {
      data_offsets: [
        toSafeNumber(offset, `${tensor.name} start offset`),
        toSafeNumber(nextOffset, `${tensor.name} end offset`),
      ],
      dtype: tensor.dtype,
      shape: tensor.shape,
    }
    offset = nextOffset
  }
  const json = JSON.stringify(header)
  const paddingLength = (8 - Buffer.byteLength(json) % 8) % 8
  return Buffer.from(`${json}${' '.repeat(paddingLength)}`)
}
const copySegment = async (sourceHandle: FileHandle, outputHandle: FileHandle, tensor: ParsedTensor, outputPosition: bigint) => {
  const buffer = Buffer.allocUnsafe(Math.min(copyBufferSize, toSafeNumber(tensor.dataLength, `${tensor.name} byte length`)))
  let remaining = tensor.dataLength
  let readPosition = tensor.dataStart
  let writePosition = outputPosition
  while (remaining > 0n) {
    const chunkSize = Number(remaining > BigInt(buffer.length) ? buffer.length : remaining)
    const {bytesRead} = await sourceHandle.read(buffer, 0, chunkSize, toSafeNumber(readPosition, `${tensor.name} read position`))
    if (bytesRead === 0) {
      throw new Error(`Unexpected end of file while copying ${tensor.name} from ${tensor.file}.`)
    }
    await outputHandle.write(buffer, 0, bytesRead, toSafeNumber(writePosition, `${tensor.name} write position`))
    remaining -= BigInt(bytesRead)
    readPosition += BigInt(bytesRead)
    writePosition += BigInt(bytesRead)
  }
}
const writeMergedSafetensors = async (outputFile: string, tensors: Array<ParsedTensor>, metadata?: Record<string, string>) => {
  const partialFile = `${outputFile}.merge-${process.pid}-${Date.now()}.partial`
  const header = makeMergedHeader(tensors, metadata)
  const headerLengthBuffer = Buffer.allocUnsafe(8)
  headerLengthBuffer.writeBigUInt64LE(BigInt(header.length))
  const dataStart = BigInt(8 + header.length)
  let outputPosition = dataStart
  await fs.remove(partialFile)
  const outputHandle = await fs.promises.open(partialFile, 'w')
  let sourceHandle: FileHandle | undefined
  let sourceFile = ''
  try {
    await outputHandle.write(headerLengthBuffer, 0, headerLengthBuffer.length, 0)
    await outputHandle.write(header, 0, header.length, 8)
    for (const tensor of tensors) {
      if (tensor.file !== sourceFile) {
        await sourceHandle?.close()
        sourceHandle = await fs.promises.open(tensor.file, 'r')
        sourceFile = tensor.file
      }
      if (!sourceHandle) {
        throw new Error(`Could not open safetensors shard ${tensor.file}.`)
      }
      await copySegment(sourceHandle, outputHandle, tensor, outputPosition)
      outputPosition += tensor.dataLength
    }
  } catch (error) {
    await sourceHandle?.close().catch(() => {})
    await outputHandle.close().catch(() => {})
    await fs.remove(partialFile).catch(() => {})
    throw error
  }
  await sourceHandle?.close()
  await outputHandle.close()
  const stat = await fs.stat(partialFile)
  if (BigInt(stat.size) !== outputPosition) {
    await fs.remove(partialFile)
    throw new Error(`Merged file size mismatch for ${partialFile}. Expected ${outputPosition}, got ${stat.size}.`)
  }
  await fs.move(partialFile, outputFile, {overwrite: true})
}

export const mergeTarget = async (target: MergeTarget) => {
  for (const shardFile of target.shardFiles) {
    if (!await fs.pathExists(shardFile)) {
      throw new Error(`Cannot merge ${target.outputFile}; shard file does not exist: ${shardFile}`)
    }
  }
  const startedAt = Date.now()
  await fs.ensureDir(pathUtil.dirname(target.outputFile))
  const shards = []
  for (const shardFile of target.shardFiles) {
    shards.push(await parseShard(shardFile))
  }
  const metadata = shards.find(shard => shard.metadata)?.metadata
  const tensors = shards.flatMap(shard => shard.tensors)
  const tensorNames = new Set<string>
  for (const tensor of tensors) {
    if (tensorNames.has(tensor.name)) {
      throw new Error(`Cannot merge ${target.outputFile}; duplicate tensor name: ${tensor.name}`)
    }
    tensorNames.add(tensor.name)
  }
  await writeMergedSafetensors(target.outputFile, tensors, metadata)
  for (const shardFile of target.shardFiles) {
    await fs.remove(shardFile)
  }
  if (target.indexFile) {
    await fs.remove(target.indexFile)
  }
  return {
    ...target,
    durationMs: Date.now() - startedAt,
  } satisfies MergeRecord
}

export const mergeSplits = async (outputFolder: string) => {
  const targets = await findMergeTargets(outputFolder)
  const records: Array<MergeRecord> = []
  for (const target of targets) {
    records.push(await mergeTarget(target))
  }
  return records
}
