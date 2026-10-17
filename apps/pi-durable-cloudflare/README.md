# pi-durable-cloudflare

A Durable Pi harness running inside a Cloudflare **Durable Object**, on the published
`@earendil-works/*` 1.3.0 packages.

This is the Cloudflare counterpart of `apps/dpi-backend`. Where the backend keeps its
sessions in a SQLite file and is reached over HTTP, here the harness lives inside a
Durable Object and its storage **is** the object's own SQLite: `ctx.storage`, no separate
database and no connection to manage. The object owns the run, so the process can die and
the conversation continues.

## What it demonstrates

`src/index.ts` is one file, commented, and it is deliberately small:

- `openDurableObjectSqliteStorage(ctx.storage)` — the 1.3.0 adapter for a DO's SQLite.
  It is **async** (it opens and migrates).
- `Harness.open(storage, { models, registry, settings }, context)` then
  `harness.resume()`, which continues any task a previous incarnation left unfinished.
- `harness.root(context, { agent })` — a conversation stores its own agent. Without a
  `model` the submission is admitted and **never runs**; the only symptom is a
  submission that settles `unanswered` with `reason: "model_error"`.
- a tool returns `{ output: [...] }`. The field was called `content` in 1.0.3 and was
  **renamed in 1.3.0**; the old name type errors and, at runtime, yields empty output.

The model is `pi-ai`'s **faux** provider, so the whole durable loop runs offline with no
API key. Note the faux handle has to re-arm itself: the reply factory calls
`handle.appendResponses([reply])` before returning, or the second model request fails
with "No more faux responses queued".

## Run it

```bash
just cloudflare dev     # Durable Object on http://127.0.0.1:8899
just cloudflare demo    # in a second shell: the four curls below
```

```bash
curl -s -X POST localhost:8899/message -H 'content-type: application/json' -d '{"content":"hello"}'
# → {"status":"done","answer":"Echo: hello"}

curl -s -X POST localhost:8899/message -H 'content-type: application/json' -d '{"content":"tool: ping"}'
# → {"status":"done","answer":"Tool said: echo: ping"}     the tool call ran as a durable task

curl -s -X POST localhost:8899/message -H 'content-type: application/json' \
     -H 'x-request-id: job-42' -d '{"content":"once"}'
curl -s -X POST localhost:8899/message -H 'content-type: application/json' \
     -H 'x-request-id: job-42' -d '{"content":"once"}'
# → both return the same answerEntryId: requestId makes a submission exactly-once

curl -s localhost:8899/transcript
# → entries + the request messages the model saw
```

Then stop `just cloudflare dev`, start it again and repeat the last curl: the entries are
still there. The Durable Object's SQLite outlives the process.

## Deploy

```bash
npx wrangler secret put <PROVIDER>_API_KEY   # when you swap faux for a real provider
just cloudflare deploy
```

**Do not expose it as is.** It has no authentication and no rate limiting: anyone who can
reach it can create sessions that spend your model credentials. The upstream sample says
the same about itself.

## Versions

Pinned exactly to match `apps/dpi-backend`. Bumping `chord` / `pi-ai` / `pi-durable`
means re-running `just cloudflare check` and the demo above.
