import {expect, test} from 'bun:test'
import os from 'node:os'

import * as pathUtil from 'forward-slash-path'
import fs from 'fs-extra'

import {findMergeTargets, mergeTarget} from '../src/main.ts'

type FakeTensor = {
  data: Buffer
  dtype: string
  shape: Array<number>
}

type ReadTensor = FakeTensor & {
  name: string
}

type ReadSafetensors = {
  metadata?: Record<string, string>
  tensors: Array<ReadTensor>
}

const metadataKey = '__metadata__'
const dtypeRanks = new Map([
  'BOOL',
  'F4',
  'F6_E2M3',
  'F6_E3M2',
  'U8',
  'I8',
  'F8_E5M2',
  'F8_E4M3',
  'F8_E8M0',
  'F8_E4M3FNUZ',
  'F8_E5M2FNUZ',
  'I16',
  'U16',
  'F16',
  'BF16',
  'I32',
  'U32',
  'F32',
  'C64',
  'F64',
  'I64',
  'U64',
].map((dtype, index) => [dtype, index]))
const makeTempFolder = async () => {
  return fs.mkdtemp(pathUtil.join(os.tmpdir(), 'merge-safetensors-test-'))
}
const compareUtf8 = (left: string, right: string) => {
  return Buffer.compare(Buffer.from(left), Buffer.from(right))
}
const compareReferenceSaveOrder = (left: ReadTensor, right: ReadTensor) => {
  return (dtypeRanks.get(right.dtype) ?? -1) - (dtypeRanks.get(left.dtype) ?? -1) || compareUtf8(left.name, right.name)
}
const writeFakeSafetensors = async (file: string, tensors: Record<string, FakeTensor>, metadata?: Record<string, string>) => {
  const header: Record<string, unknown> = {}
  if (metadata) {
    header[metadataKey] = metadata
  }
  let offset = 0
  for (const [name, tensor] of Object.entries(tensors)) {
    header[name] = {
      dtype: tensor.dtype,
      shape: tensor.shape,
      data_offsets: [offset, offset + tensor.data.length],
    }
    offset += tensor.data.length
  }
  const headerJson = JSON.stringify(header)
  const paddingLength = (8 - Buffer.byteLength(headerJson) % 8) % 8
  const headerBuffer = Buffer.from(`${headerJson}${' '.repeat(paddingLength)}`)
  const lengthBuffer = Buffer.allocUnsafe(8)
  lengthBuffer.writeBigUInt64LE(BigInt(headerBuffer.length))
  await fs.outputFile(file, Buffer.concat([lengthBuffer, headerBuffer, ...Object.values(tensors).map(tensor => tensor.data)]))
}
const readSafetensors = async (file: string): Promise<ReadSafetensors> => {
  const buffer = await fs.readFile(file)
  const headerLength = Number(buffer.readBigUInt64LE())
  const header = JSON.parse(buffer.subarray(8, 8 + headerLength).toString('utf8')) as Record<string, Record<string, string> | {data_offsets: [number, number]
    dtype: string
    shape: Array<number>}>
  const dataStart = 8 + headerLength
  const tensors: Array<ReadTensor> = []
  for (const [name, entry] of Object.entries(header)) {
    if (name === metadataKey) {
      continue
    }
    const tensor = entry as {data_offsets: [number, number]
      dtype: string
      shape: Array<number>}
    const [start, end] = tensor.data_offsets
    tensors.push({
      data: buffer.subarray(dataStart + start, dataStart + end),
      dtype: tensor.dtype,
      name,
      shape: tensor.shape,
    })
  }
  return {
    metadata: header[metadataKey] as Record<string, string> | undefined,
    tensors,
  }
}
const writeSafetensors = async (file: string, tensors: Array<ReadTensor>, metadata?: Record<string, string>) => {
  await writeFakeSafetensors(file, Object.fromEntries(tensors.map(tensor => [tensor.name, tensor])), metadata)
}
const writeReferenceMergedSafetensors = async (shardFiles: Array<string>, outputFile: string) => {
  const tensors = new Map<string, ReadTensor>
  let metadata: Record<string, string> | undefined
  for (const shardFile of shardFiles) {
    const shard = await readSafetensors(shardFile)
    metadata = shard.metadata
    for (const tensor of shard.tensors.toSorted((left, right) => compareUtf8(left.name, right.name))) {
      tensors.set(tensor.name, tensor)
    }
  }
  const sortedTensors = [...tensors.values()].toSorted(compareReferenceSaveOrder)
  await writeSafetensors(outputFile, sortedTensors, metadata)
}
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
test('mergeTarget matches the materializing reference merge procedure', async () => {
  const folder = await makeTempFolder()
  try {
    const firstShard = pathUtil.join(folder, 'model-00001-of-00002.safetensors')
    const secondShard = pathUtil.join(folder, 'model-00002-of-00002.safetensors')
    const indexFile = pathUtil.join(folder, 'model.safetensors.index.json')
    const outputFile = pathUtil.join(folder, 'model.safetensors')
    const referenceOutputFile = pathUtil.join(folder, 'reference.safetensors')
    await writeFakeSafetensors(firstShard, {
      alpha_f32: {
        data: Buffer.from([1, 2, 3, 4]),
        dtype: 'F32',
        shape: [1],
      },
      z_u8: {
        data: Buffer.from('zz'),
        dtype: 'U8',
        shape: [2],
      },
    }, {
      format: 'pt',
      shard: 'first',
    })
    await writeFakeSafetensors(secondShard, {
      aardvark_f32: {
        data: Buffer.from([5, 6, 7, 8]),
        dtype: 'F32',
        shape: [1],
      },
      beta_i16: {
        data: Buffer.from([9, 10, 11, 12]),
        dtype: 'I16',
        shape: [2],
      },
    }, {
      format: 'pt',
      shard: 'second',
    })
    await fs.outputJson(indexFile, {
      weight_map: {
        aardvark_f32: pathUtil.basename(secondShard),
        alpha_f32: pathUtil.basename(firstShard),
        beta_i16: pathUtil.basename(secondShard),
        z_u8: pathUtil.basename(firstShard),
      },
    })
    await writeReferenceMergedSafetensors([firstShard, secondShard], referenceOutputFile)
    const record = await mergeTarget({
      indexFile,
      outputFile,
      shardFiles: [firstShard, secondShard],
    })
    expect(record.shardFiles).toEqual([firstShard, secondShard])
    await expect(fs.pathExists(firstShard)).resolves.toBe(false)
    await expect(fs.pathExists(secondShard)).resolves.toBe(false)
    await expect(fs.pathExists(indexFile)).resolves.toBe(false)
    expect(await fs.readFile(outputFile)).toEqual(await fs.readFile(referenceOutputFile))
    const merged = await readSafetensors(outputFile)
    expect(merged.metadata).toEqual({
      format: 'pt',
      shard: 'second',
    })
    expect(merged.tensors.map(tensor => tensor.name)).toEqual(['aardvark_f32', 'alpha_f32', 'beta_i16', 'z_u8'])
  } finally {
    await fs.remove(folder)
  }
})
