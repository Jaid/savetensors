import {defineCommand} from 'clerc'

import {run} from './run.ts'

const command = defineCommand({
  description: 'run a Hugging Face download',
  flags: {
    baseFolder: {
      type: String,
      description: 'base folder template for relative target folders; defaults to the current working directory',
    },
    dump: {
      type: Boolean,
      description: 'perform a dry run and print a JSON object consisting of context and diagnostics',
    },
    eagerSkip: {
      type: Boolean,
      description: 'skip the repository before listing/downloading when the resolved target folder already exists',
    },
    fancy: {
      type: Boolean,
      description: 'enables terminal fanciness: ANSI progress, process.title percentage and OSC 9;4 terminal progress',
    },
    folder: {
      default: '{{owner}}/{{repo}}',
      description: 'Handlebars-like target folder template (variables: owner, repo, revision, sourceId, sourceDomain, home, temp)',
      type: String,
    },
    mergeSplits: {
      type: Boolean,
      description: 'merge split .safetensors shards with a streaming container rewrite; successful merges delete the original split files and index file',
    },
    omitFile: {
      type: [String],
      description: 'file names at any level of the file tree to skip',
    },
    omitFolder: {
      type: [String],
      description: 'folder names at any level of the file tree to skip',
    },
    omitPattern: {
      type: [String],
      description: 'Picomatch patterns to skip',
    },
    omitStem: {
      type: [String],
      description: 'file name stems without the last extension to skip',
    },
    omitSuffix: {
      type: [String],
      description: 'file extensions without leading dot to skip',
    },
    onlyFile: {
      type: [String],
      description: 'file names at any level of the file tree to exclusively download',
    },
    onlyFolder: {
      type: [String],
      description: 'folder names at any level of the file tree to exclusively download',
    },
    onlyPattern: {
      type: [String],
      description: 'Picomatch patterns to exclusively download',
    },
    onlyStem: {
      type: [String],
      description: 'file name stems without the last extension to exclusively download',
    },
    onlySuffix: {
      type: [String],
      description: 'file extensions without leading dot to exclusively download',
    },
    overwriteStrategy: {
      default: 'mismatch',
      description: 'existing-file strategy: mismatch, wipe, skip, error or keep',
      type: String,
    },
    partialFolder: {
      default: '{{outputFolder}}/.partial',
      description: 'temporary download folder template; use an empty string to stream directly next to the target file',
      type: String,
    },
    pedantic: {
      type: Boolean,
      description: 'download metadata that is skipped by default and create empty remote folders',
    },
    ref: {
      type: String,
      description: 'alias for --revision',
    },
    repo: {
      type: [String],
      description: 'alias for --url',
    },
    revision: {
      type: String,
      description: 'Git branch name, tag or commit hash; defaults to the latest commit on the default branch',
    },
    token: {
      type: String,
      description: 'Hugging Face access token; HF_TOKEN is used when omitted',
    },
    url: {
      type: [String],
      description: 'remote repository as owner/name, typed slug like datasets/owner/name or a huggingface.co URL',
    },
  },
  name: '',
  parameters: ['[url...]'],
// eslint-disable-next-line typescript/no-misused-promises
}, context => run(context))

export default command
