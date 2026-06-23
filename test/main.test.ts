import type {FilterOptions} from '#src/lib/types.ts'

import {expect, test} from 'bun:test'
import os from 'node:os'

import * as pathUtil from 'forward-slash-path'
import fs from 'fs-extra'

import {filterEntries, findMergeTargets, parseRepo, shouldIncludePath} from '#src/main.ts'

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
