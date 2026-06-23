import type {ParsedRepo} from './types.ts'
import type {RepoDesignation, RepoType} from '@huggingface/hub'

const huggingFaceHosts = new Set(['hf.co', 'huggingface.co', 'www.huggingface.co'])
const typePrefixMap = new Map<string, RepoType>([
  ['bucket', 'bucket'],
  ['buckets', 'bucket'],
  ['dataset', 'dataset'],
  ['datasets', 'dataset'],
  ['kernel', 'kernel'],
  ['kernels', 'kernel'],
  ['model', 'model'],
  ['models', 'model'],
  ['space', 'space'],
  ['spaces', 'space'],
])
const revisionPathMarkers = new Set(['blob', 'edit', 'raw', 'resolve', 'tree'])
const filePathMarkers = new Set(['blob', 'raw', 'resolve'])
const makeRepoDesignation = (type: RepoType, name: string): RepoDesignation => {
  if (type === 'model') {
    return name
  }
  return {
    type,
    name,
  }
}
const decodePathPart = (part: string) => {
  try {
    return decodeURIComponent(part)
  } catch {
    return part
  }
}
const normalizeInputToParts = (input: string) => {
  const trimmedInput = input.trim().replace(/\.git$/u, '')
  if (!trimmedInput) {
    throw new Error('Repository URL or slug must not be empty.')
  }
  if (!/^https?:\/\//iu.test(trimmedInput)) {
    return trimmedInput.replaceAll(/^\/+|\/+$/gu, '').split('/').filter(Boolean).map(decodePathPart)
  }
  const url = new URL(trimmedInput)
  if (!huggingFaceHosts.has(url.hostname.toLowerCase())) {
    throw new Error(`Expected a huggingface.co URL, received ${url.hostname}.`)
  }
  return url.pathname.replaceAll(/^\/+|\/+$/gu, '').split('/').filter(Boolean).map(decodePathPart)
}

export const parseRepo = (input: string): ParsedRepo => {
  const parts = normalizeInputToParts(input)
  let type: RepoType = 'model'
  let index = 0
  const firstPartType = typePrefixMap.get(parts[0]?.toLowerCase() ?? '')
  if (firstPartType) {
    type = firstPartType
    index = 1
  }
  const owner = parts[index]
  const repoName = parts[index + 1]
  if (!owner || !repoName) {
    throw new Error(`Invalid Hugging Face repository reference: ${input}`)
  }
  const name = `${owner}/${repoName}`
  const tail = parts.slice(index + 2)
  let forcedPath: string | undefined
  let revision: string | undefined
  const marker = tail[0]
  if (marker && revisionPathMarkers.has(marker)) {
    revision = tail[1]
    if (filePathMarkers.has(marker) && tail.length > 2) {
      forcedPath = tail.slice(2).join('/')
    }
  } else if (marker === 'commit') {
    revision = tail[1]
  }
  if (revision === '') {
    revision = undefined
  }
  return {
    forcedPath,
    name,
    owner,
    repo: makeRepoDesignation(type, name),
    repoName,
    revision,
    type,
  }
}

export const repoKindPrefix = (type: RepoType) => {
  if (type === 'model') {
    return ''
  }
  return `${type}s/`
}

export const repoDisplayName = (repo: ParsedRepo) => {
  return `${repoKindPrefix(repo.type)}${repo.name}`
}
