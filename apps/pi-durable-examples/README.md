# pi-durable-examples

The 32 numbered examples from [`packages/durable/test/examples`](https://github.com/earendil-works/pi/tree/main/packages/durable/test/examples)
of the Pi monorepo, wired to run **against the published npm packages** instead of the
monorepo source.

## Why this exists

Upstream, each example imports `../../src/index.ts` and is meant to be run from
`packages/durable` with `node --conditions=source --experimental-strip-types`. That
only proves the examples work against the source tree in the repo they ship in. It
says nothing about the tarballs you actually install.

Here the relative imports are rewritten to the public subpaths:

| upstream | here |
|---|---|
| `../../src/index.ts` | `@earendil-works/pi-durable` |
| `../../src/tools/index.ts` | `@earendil-works/pi-durable/tools` |
| `../../src/env/node.ts` | `@earendil-works/pi-durable/env/node` |
| `../../src/storage/sqlite/node.ts` | `@earendil-works/pi-durable/storage/sqlite/node` |
| `../../src/storage/jsonl/node.ts` | `@earendil-works/pi-durable/storage/jsonl/node` |

So a green run is evidence that the **published** `chord` + `pi-ai` + `pi-durable` still
export everything the examples use. That is the check that catches a renamed field or a
dropped subpath before an app breaks on it.

## Run

```bash
just examples run              # all 32, four at a time
just examples one 13-recovery  # one example by name
```

`_run.mjs` runs each example in its own process with a timeout and prints
`PASS`/`FAIL`/`TIMEOUT` per file. `16-real-model` uses `OPENAI_API_KEY` when set and
falls back to the scripted faux model otherwise, so the suite needs no credentials.

## Refreshing after an upstream change

```bash
just examples fetch            # re-download the 32 files and rewrite their imports
```

`fetch` reads them from the **pinned tag** `v1.3.0` (`71023aec`), not from `main`, so a green
run means something. Bump `REF` in `fetch-examples.mjs` together with the three package
versions, then run `just examples run`. `fetch` re-applies the same rewrite table, so a new
upstream example arrives already pointing at the public subpaths, and it **fails loudly** if
upstream introduces an import shape the table does not cover.

## Provenance

The 32 files are upstream code from [`earendil-works/pi`](https://github.com/earendil-works/pi)
(`packages/durable/test/examples`), MIT licensed, same licence as this repo. The only local
change is the import rewrite described above; keep it that way so a diff against upstream
stays readable.

## Versions

The three packages are pinned exactly in `package.json`. Bump them together with
`apps/dpi-backend` and `apps/proactive-dpi-demo`, then run `just examples run`: that is
the cheapest way to see whether the bump broke a public API.
