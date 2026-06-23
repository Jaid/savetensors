import type {MergeRecord, MergeTarget} from './types.ts'

import * as pathUtil from 'forward-slash-path'
import fs from 'fs-extra'

const safetensorsIndexSuffix = '.safetensors.index.json'
const safetensorsShardPattern = /^(?<prefix>.+)-(?<part>\d{5})-of-(?<total>\d{5})\.safetensors$/u
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

const makeMergeScript = () => {
  return `import json, os
from safetensors import safe_open
from safetensors.torch import save_file
files = json.loads(os.environ['SAVETENSORS_MERGE_FILES'])
outputFile = os.environ['SAVETENSORS_MERGE_OUTPUT_FILE']
tensors = {}
metadata = None
for file in files:
  with safe_open(file, framework='pt') as shard:
    if metadata is None:
      metadata = shard.metadata()
    for layer in shard.keys():
      tensor = shard.get_tensor(str(layer))
      tensors[str(layer)] = tensor
save_file(tensors, outputFile, metadata)
`
}

export const mergeTarget = async (target: MergeTarget) => {
  for (const shardFile of target.shardFiles) {
    if (!await fs.pathExists(shardFile)) {
      throw new Error(`Cannot merge ${target.outputFile}; shard file does not exist: ${shardFile}`)
    }
  }
  const startedAt = Date.now()
  await fs.ensureDir(pathUtil.dirname(target.outputFile))
  await fs.remove(target.outputFile)
  const proc = Bun.spawn(['uv', 'run', '--with', 'safetensors', '--with', 'torch', '--with', 'numpy', 'python', '-'], {
    env: {
      ...Bun.env,
      SAVETENSORS_MERGE_FILES: JSON.stringify(target.shardFiles),
      SAVETENSORS_MERGE_OUTPUT_FILE: target.outputFile,
    },
    stderr: 'pipe',
    stdin: 'pipe',
    stdout: 'pipe',
  })
  await proc.stdin.write(makeMergeScript())
  await proc.stdin.end()
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  if (exitCode !== 0) {
    throw new Error(`Safetensors merge failed for ${target.outputFile} with exit code ${exitCode}.\n${stderr}\n${stdout}`.trim())
  }
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
