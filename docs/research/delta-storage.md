# Efficient Delta Storage for Coding Agent Iterations

> Research: Approaches for space-efficient (and time-efficient) storage of folder deltas between coding agent iterations on a project codebase with binary build artifacts.

## Context & Constraints

- **Target folder may contain a `.git` repo** — solution must not interfere with it
- **Mixed content**: source code (text) + binary build artifacts
- **Small incremental changes** between iterations relative to the total codebase size
- **JavaScript/TypeScript ecosystem** preferred
- **Space efficiency** is the primary goal; time efficiency is secondary

---

## Approaches

### Approach A: Git with Separate `GIT_DIR`

Use git's content-addressable storage and packfile delta compression, but in an **isolated** git database to avoid polluting the project's own `.git`.

```bash
GIT_DIR=/tmp/agent-snapshots/.git git --work-tree=/path/to/project add -A && commit -m "iteration N"
```

**npm packages:**
- `simple-git` (10.7M downloads/week) — CLI wrapper around git
- `isomorphic-git` (782K downloads/week) — pure JS git implementation

**Pros:**
- World-class packfile delta compression (10-100x on codebases)
- Content-addressable deduplication is automatic
- Tree diffing built-in
- Portable export via `git bundle`

**Cons:**
- Needs custom ignore rules (project's `.gitignore` may exclude build artifacts you want to capture)
- Git's delta compression is generic — not tuned for specific codebase patterns
- `isomorphic-git` packfile generation is slower than native git
- Managing a parallel `GIT_DIR` adds operational complexity

**Best for:** When git is available on the system and you don't need to capture files excluded by `.gitignore`.

---

### Approach B: Custom CAS + Binary Delta (Recommended)

Build a pipeline that's fully independent of the project's git repo.

#### Pipeline

1. **Walk & hash**: Traverse directory tree, SHA-256 hash every file → `manifest.json` (path → hash, size, mtime)
2. **Dedup**: Content-addressable blob store — only store new/changed blobs
3. **Delta**: For changed files (same path, different hash), compute binary delta
4. **Compress**: Bundle deltas + new files, compress with zstd (optionally with trained dictionary)
5. **Store**: Each iteration = manifest + delta bundle. Restore by applying deltas forward from base.

#### Key Libraries

| Library | Purpose | npm Downloads/wk | Notes |
|---------|---------|-----------------|-------|
| `dir-compare` | Directory tree comparison | 1.6M | TypeScript, glob/gitignore filters, extensible |
| `folder-hash` | Recursive hash tree | 265K | Fast change detection via hash comparison |
| `fossil-delta` | Binary delta (pure JS) | 434 | Simple API, `Uint8Array` in/out, 39 kB, checksum verification |
| `bsdiff-node` | Binary delta (native) | 1.2K | Best binary delta ratios (used by Chrome/Firefox updaters), maintenance mode |
| `xdelta3-wasm` | VCDIFF delta (WASM) | 6 | Industry standard (RFC 3284), cross-platform, 1.62 MB WASM payload |
| `zstd-napi` | Zstandard compression | 19.7K | **Dictionary compression** — killer feature for small code deltas |
| `lz4-napi` | LZ4 compression | 33.6K | Fastest decompression, dictionary support |
| `diff-match-patch` | Text diff/patch | 15M | Google's library, text-only, excellent quality |

#### Binary Delta Library Comparison

| Library | Type | Binary Quality | Text Quality | Pure JS | Streaming |
|---------|------|---------------|-------------|---------|-----------|
| `fossil-delta` | Pure JS | Good | Good | Yes | No |
| `bsdiff-node` | Native addon | **Best** | Good | No | No |
| `xdelta3-wasm` | WASM | Very good | Very good | Yes (WASM) | No |
| `diff-match-patch` | Pure JS | N/A (text only) | **Best** | Yes | No |

#### Compression Comparison

| Algorithm | Ratio | Compress Speed | Decompress Speed | Dictionary Support | npm Package |
|-----------|-------|---------------|-----------------|-------------------|-------------|
| **zstd** | Excellent | Fast | Very fast | **Yes** | `zstd-napi` |
| brotli | Best | Slow | Fast | Limited | built-in `zlib` |
| gzip | Good | Medium | Medium | No | built-in `zlib` |
| **lz4** | Fair | Fastest | Fastest | Yes | `lz4-napi` |

**Why dictionary compression matters:** Train a zstd dictionary on representative source code from the codebase. For small delta payloads (typical of agent iterations), dictionary compression improves ratios by **2-5x** over generic compression.

**Pros:**
- No interference with project's `.git`
- Full control over what's included (binaries, `node_modules`, build artifacts)
- Tunable compression with dictionaries
- Best possible space efficiency

**Cons:**
- More implementation effort
- Must manage blob store lifecycle (cleanup, compaction)
- Delta chain restoration is slower than git checkout

---

### Approach C: Tar Layer + Compression (Docker-Style)

Simplest custom approach, inspired by Docker image layers.

1. `dir-compare` → identify changed/added/deleted files
2. Create tar archive of only changed files + deletion manifest (whiteout markers)
3. Compress with `zstd-napi` or Node built-in brotli

**npm packages:**
- `tar` (57M downloads/week) — standard tar creation/extraction
- `archiver` (18.5M downloads/week) — streaming archive generation

**Pros:**
- Dead simple implementation
- Fast to create and apply
- No dependency chain issues

**Cons:**
- No intra-file delta — stores full changed files
- Worst space efficiency of the three approaches
- Large binary changes = large layers

---

## Decision Matrix

| Factor | Git Separate DIR (A) | CAS + Delta (B) | Tar Layer (C) |
|--------|---------------------|------------------|---------------|
| **Space efficiency** | ★★★★★ | ★★★★★ | ★★★ |
| **Implementation effort** | Low | High | Trivial |
| **Speed (snapshot)** | Fast | Medium | Fastest |
| **Binary handling** | Great | Best | Good |
| **Captures ignored files** | Needs `-f` | Yes | Yes |
| **Existing `.git` safe** | Yes (separate DIR) | Yes | Yes |
| **Restore speed** | Instant (checkout) | Slow (delta chain) | Fast |
| **Dependencies** | `git` binary | Multiple npm | Minimal |
| **Dictionary compression** | No | Yes (zstd) | Yes (zstd) |

---

## Recommendation

**For most coding agent scenarios: Approach B (Custom CAS + Delta)**

1. Use `folder-hash` or raw `crypto.createHash('sha256')` for file hashing
2. Use `fossil-delta` for per-file binary deltas (pure JS, no native deps)
3. Use `zstd-napi` with trained dictionary for compression
4. Skip the project's `.git` directory (and optionally `node_modules`, etc.)
5. Store periodic **full snapshots** (every N iterations) to bound delta chain length and restore time

**Fallback**: If simplicity is paramount and space efficiency is acceptable (not critical), use **Approach C** (tar layer) with zstd compression.

**If git is guaranteed available** and you don't need to capture `.gitignore`d files, **Approach A** with a separate `GIT_DIR` is the lowest-effort high-quality option.

---

## References

- [fossil-delta on npm](https://www.npmjs.com/package/fossil-delta)
- [bsdiff-node on npm](https://www.npmjs.com/package/bsdiff-node)
- [xdelta3-wasm on npm](https://www.npmjs.com/package/xdelta3-wasm)
- [dir-compare on npm](https://www.npmjs.com/package/dir-compare)
- [folder-hash on npm](https://www.npmjs.com/package/folder-hash)
- [zstd-napi on npm](https://www.npmjs.com/package/zstd-napi)
- [simple-git on npm](https://www.npmjs.com/package/simple-git)
- [isomorphic-git on npm](https://www.npmjs.com/package/isomorphic-git)
- [diff-match-patch on npm](https://www.npmjs.com/package/diff-match-patch)
- [RFC 3284 — VCDIFF](https://tools.ietf.org/html/rfc3284)
- [Zstandard dictionary compression](https://facebook.github.io/zstd/#small-data)
