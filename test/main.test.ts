import type {FilterOptions} from '#src/lib/types.ts'

import {expect, test} from 'bun:test'
import os from 'node:os'

import * as pathUtil from 'forward-slash-path'
import fs from 'fs-extra'

import {collectSourceUrls} from '#src/commands/main/run.ts'
import {Downloader, filterEntries, findMergeTargets, mergeTarget, parseRepo, shouldIncludePath} from '#src/main.ts'

const baseFilterOptions: FilterOptions = {
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
  pedantic: false,
}
const makeTempFolder = async () => {
  return fs.mkdtemp(pathUtil.join(os.tmpdir(), 'savetensors-test-'))
}
const metadataKey = '__metadata__'
const writeFakeSafetensors = async (file: string, tensors: Record<string, Buffer>, metadata?: Record<string, string>) => {
  const header: Record<string, unknown> = {}
  if (metadata) {
    header[metadataKey] = metadata
  }
  let offset = 0
  for (const [name, data] of Object.entries(tensors)) {
    header[name] = {
      data_offsets: [offset, offset + data.length],
      dtype: 'U8',
      shape: [data.length],
    }
    offset += data.length
  }
  const headerJson = JSON.stringify(header)
  const paddingLength = (8 - Buffer.byteLength(headerJson) % 8) % 8
  const headerBuffer = Buffer.from(`${headerJson}${' '.repeat(paddingLength)}`)
  const lengthBuffer = Buffer.allocUnsafe(8)
  lengthBuffer.writeBigUInt64LE(BigInt(headerBuffer.length))
  await fs.outputFile(file, Buffer.concat([lengthBuffer, headerBuffer, ...Object.values(tensors)]))
}
const readFakeSafetensors = async (file: string) => {
  const buffer = await fs.readFile(file)
  const headerLength = Number(buffer.readBigUInt64LE())
  const header = JSON.parse(buffer.subarray(8, 8 + headerLength).toString('utf8')) as Record<string, Record<string, string> | {data_offsets: [number, number]}>
  const dataStart = 8 + headerLength
  const tensors: Record<string, string> = {}
  for (const [name, entry] of Object.entries(header)) {
    if (name === metadataKey) {
      continue
    }
    const [start, end] = (entry as {data_offsets: [number, number]}).data_offsets
    tensors[name] = buffer.subarray(dataStart + start, dataStart + end).toString('utf8')
  }
  return {
    header,
    tensors,
  }
}
test('parseRepo parses model slugs', () => {
  expect(parseRepo('Qwen/Qwen3.5-0.8B')).toMatchObject({
    name: 'Qwen/Qwen3.5-0.8B',
    owner: 'Qwen',
    repoName: 'Qwen3.5-0.8B',
    type: 'model',
  })
})
test('parseRepo parses typed URLs, revisions and forced files', () => {
  expect(parseRepo('https://huggingface.co/datasets/HuggingFaceFW/fineweb/tree/refs%2Fconvert%2Fparquet')).toMatchObject({
    name: 'HuggingFaceFW/fineweb',
    revision: 'refs/convert/parquet',
    type: 'dataset',
  })
  expect(parseRepo('https://huggingface.co/nvidia/Cosmos3-Nano/resolve/138d071cee76860b0d2acd253dc6a07a11e3f3c1/model.safetensors.index.json')).toMatchObject({
    forcedPath: 'model.safetensors.index.json',
    revision: '138d071cee76860b0d2acd253dc6a07a11e3f3c1',
  })
})
test('filterEntries applies default skips unless pedantic or explicitly selected', () => {
  const entries = [
    {
      path: '.gitattributes',
      size: 20,
      type: 'file',
    },
    {
      path: 'LICENSE',
      size: 100,
      type: 'file',
    },
    {
      path: 'README.md',
      size: 200,
      type: 'file',
    },
  ] as const
  expect(filterEntries([...entries], baseFilterOptions).files.map(file => file.path)).toEqual(['README.md'])
  expect(filterEntries([...entries], {
    ...baseFilterOptions,
    pedantic: true,
  }).files.map(file => file.path)).toEqual(['.gitattributes', 'LICENSE', 'README.md'])
  expect(filterEntries([...entries], {
    ...baseFilterOptions,
    onlyFile: ['LICENSE'],
  }).files.map(file => file.path)).toEqual(['LICENSE'])
})
test('filterEntries gives omit filters precedence over only filters', () => {
  const entries = [
    {
      path: 'BF16/model-00001-of-00002.safetensors',
      size: 10,
      type: 'file',
    },
    {
      path: 'GGUF/model-Q4_K_M.gguf',
      size: 10,
      type: 'file',
    },
    {
      path: 'tokenizer.json',
      size: 10,
      type: 'file',
    },
  ] as const
  const result = filterEntries([...entries], {
    ...baseFilterOptions,
    omitFolder: ['BF16'],
    onlyPattern: ['**/*.{safetensors,gguf}', '*.json'],
    onlySuffix: ['json'],
  })
  expect(result.files.map(file => file.path)).toEqual(['GGUF/model-Q4_K_M.gguf', 'tokenizer.json'])
  expect(result.excluded.find(entry => entry.entry.path.startsWith('BF16/'))?.reason).toContain('--omit-folder')
})
test('forced paths bypass default skips but not explicit omit filters', () => {
  expect(shouldIncludePath('LICENSE', baseFilterOptions, true, 'LICENSE').include).toBe(true)
  expect(shouldIncludePath('LICENSE', {
    ...baseFilterOptions,
    omitFile: ['LICENSE'],
  }, true, 'LICENSE').include).toBe(false)
})
test('Downloader folder templates support base folders and source variables', async () => {
  const baseFolder = await makeTempFolder()
  try {
    const downloader = new Downloader({
      baseFolder,
      folder: '{{sourceId}}/{{sourceDomain}}/{{owner}}/{{repo}}/{{revision}}',
      partialFolder: '',
      revision: 'abc123',
      url: 'acme/widgets',
    })
    ;(downloader as unknown as {listRepositoryEntries: () => Promise<[]>}).listRepositoryEntries = async () => []
    const dump = await downloader.dump()
    expect(dump.context.baseFolder).toBe(baseFolder)
    expect(dump.context.folder).toBe(pathUtil.resolve(baseFolder, 'hugging_face/huggingface.co/acme/widgets/abc123'))
    expect(dump.context.partialFolder).toBe('')
  } finally {
    await fs.remove(baseFolder)
  }
})
test('Downloader eagerly skips existing target folders before listing', async () => {
  const baseFolder = await makeTempFolder()
  try {
    await fs.ensureDir(pathUtil.join(baseFolder, 'target'))
    const downloader = new Downloader({
      baseFolder,
      eagerSkip: true,
      folder: 'target',
      partialFolder: '',
      url: 'acme/widgets',
    })
    ;(downloader as unknown as {resolveLatestRevision: () => Promise<string>}).resolveLatestRevision = async () => {
      throw new Error('latest revision should not be resolved')
    }
    ;(downloader as unknown as {listRepositoryEntries: () => Promise<[]>}).listRepositoryEntries = async () => {
      throw new Error('repository should not be listed')
    }
    const dump = await downloader.dump()
    expect(dump.context.folder).toBe(pathUtil.resolve(baseFolder, 'target'))
    expect(dump.diagnostics.eagerSkipped).toBe(true)
    expect(dump.diagnostics.listed.total).toBe(0)
    expect(dump.diagnostics.plannedActions).toEqual([])
  } finally {
    await fs.remove(baseFolder)
  }
})
test('collectSourceUrls preserves sequential positional and source-flag order', () => {
  expect(collectSourceUrls([
    '--url',
    'alpha/one',
    'beta/two',
    '--repo=gamma/three',
    '--folder',
    'target',
    'delta/four',
    '--omit-pattern',
    '-*.bin',
    'epsilon/five',
    '--url:https://huggingface.co/zeta/six',
  ])).toEqual([
    'alpha/one',
    'beta/two',
    'gamma/three',
    'delta/four',
    'epsilon/five',
    'https://huggingface.co/zeta/six',
  ])
})
test('findMergeTargets reads safetensors index files', async () => {
  const folder = await makeTempFolder()
  try {
    await fs.outputJson(pathUtil.join(folder, 'model.safetensors.index.json'), {
      weight_map: {
        a: 'model-00001-of-00002.safetensors',
        b: 'model-00002-of-00002.safetensors',
      },
    })
    await fs.outputFile(pathUtil.join(folder, 'model-00001-of-00002.safetensors'), '')
    await fs.outputFile(pathUtil.join(folder, 'model-00002-of-00002.safetensors'), '')
    const targets = await findMergeTargets(folder)
    expect(targets).toHaveLength(1)
    expect(targets[0]?.outputFile).toBe(pathUtil.join(folder, 'model.safetensors'))
    expect(targets[0]?.shardFiles.map(file => pathUtil.basename(file))).toEqual(['model-00001-of-00002.safetensors', 'model-00002-of-00002.safetensors'])
  } finally {
    await fs.remove(folder)
  }
})
test('findMergeTargets falls back to shard file names without an index', async () => {
  const folder = await makeTempFolder()
  try {
    await fs.outputFile(pathUtil.join(folder, 'foo-00001-of-00002.safetensors'), '')
    await fs.outputFile(pathUtil.join(folder, 'foo-00002-of-00002.safetensors'), '')
    const targets = await findMergeTargets(folder)
    expect(targets).toHaveLength(1)
    expect(targets[0]?.outputFile).toBe(pathUtil.join(folder, 'foo.safetensors'))
  } finally {
    await fs.remove(folder)
  }
})
test('mergeTarget merges safetensors shards without materializing tensors', async () => {
  const folder = await makeTempFolder()
  try {
    const firstShard = pathUtil.join(folder, 'model-00001-of-00002.safetensors')
    const secondShard = pathUtil.join(folder, 'model-00002-of-00002.safetensors')
    const indexFile = pathUtil.join(folder, 'model.safetensors.index.json')
    const outputFile = pathUtil.join(folder, 'model.safetensors')
    await writeFakeSafetensors(firstShard, {
      alpha: Buffer.from('abc'),
      beta: Buffer.from('defg'),
    }, {
      format: 'pt',
    })
    await writeFakeSafetensors(secondShard, {
      gamma: Buffer.from('hijkl'),
    })
    await fs.outputJson(indexFile, {
      weight_map: {
        alpha: pathUtil.basename(firstShard),
        beta: pathUtil.basename(firstShard),
        gamma: pathUtil.basename(secondShard),
      },
    })
    const record = await mergeTarget({
      indexFile,
      outputFile,
      shardFiles: [firstShard, secondShard],
    })
    expect(record.shardFiles).toEqual([firstShard, secondShard])
    await expect(fs.pathExists(firstShard)).resolves.toBe(false)
    await expect(fs.pathExists(secondShard)).resolves.toBe(false)
    await expect(fs.pathExists(indexFile)).resolves.toBe(false)
    const merged = await readFakeSafetensors(outputFile)
    expect(merged.header[metadataKey]).toEqual({format: 'pt'})
    expect(merged.tensors).toEqual({
      alpha: 'abc',
      beta: 'defg',
      gamma: 'hijkl',
    })
  } finally {
    await fs.remove(folder)
  }
})
