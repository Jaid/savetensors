# savetensors

Gitless Hugging Face repository downloader for Bun. It downloads model, dataset, space, bucket or kernel repositories through the Hugging Face Hub API without `git`/Git LFS, supports precise include/exclude filters and can merge sharded `.safetensors` checkpoints through `uv` + Python.

```bash
savetensors Qwen/Qwen3.5-0.8B
```

```bash
savetensors --url ibm-granite/granite-4.1-8b --folder temp/download/granite --omit-file model.sig --omit-suffix md
```

```bash
savetensors --dump --omit-suffix md --omit-folder assets --omit-folder images --ref 138d071cee76860b0d2acd253dc6a07a11e3f3c1 --merge-splits --url https://huggingface.co/nvidia/Cosmos3-Nano --pedantic
```

```bash
savetensors unsloth/granite-4.1-30b-GGUF --omit-suffix gguf --omit-folder BF16 && savetensors unsloth/granite-4.1-30b-GGUF --only-pattern '*-UD-IQ2_M.*'
```

The package also exposes an `hf-grab` binary alias for compatibility with the fixture this implementation was derived from.

## features

- Slug and URL parsing for models plus typed `datasets/`, `spaces/`, `buckets/` and `kernels/` repositories.
- `--revision` and `--ref`, with default resolution to the latest commit on the default branch.
- `--folder` and `--partial-folder` templates with `{{owner}}`, `{{repo}}`, `{{revision}}`, `{{home}}`, `{{temp}}` and `{{outputFolder}}`.
- `--only-*` and `--omit-*` filters for files, folders, stems, suffixes and Picomatch patterns.
- Conservative default skips for `.gitattributes`, Git marker files and license/notice boilerplate, disabled by `--pedantic` or bypassed by explicit `--only-*` selection.
- Atomic-ish partial downloads, `--jobs` concurrency and overwrite strategies: `mismatch`, `wipe`, `skip`, `error` and `keep`.
- `--dump` JSON diagnostics for dry runs.
- `--merge-splits` safetensors merging based on `*.safetensors.index.json` plus a shard-name fallback.

## development

```bash
bun install
bun run lint
bun run typecheck
bun test
```