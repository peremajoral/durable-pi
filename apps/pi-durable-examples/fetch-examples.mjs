// Download the 32 pi-durable examples from the upstream monorepo and rewrite their
// relative imports to the public subpaths, so they run against the published packages.
//   node fetch-examples.mjs
//
// The ref is PINNED, not `main`: the examples are read from the tag that matches the
// package versions pinned in package.json, so a green run means something. Bump REF
// and the three versions together. Source: github.com/earendil-works/pi (MIT).
import { readdirSync, readFileSync, writeFileSync } from "node:fs";

const REF = "v1.3.0";
const UPSTREAM = `https://raw.githubusercontent.com/earendil-works/pi/${REF}/packages/durable/test/examples`;
const LIST_API = `https://api.github.com/repos/earendil-works/pi/contents/packages/durable/test/examples?ref=${REF}`;

// Upstream imports the monorepo source; we import the published subpaths.
const REWRITE = [
  ["../../src/storage/sqlite/node.ts", "@earendil-works/pi-durable/storage/sqlite/node"],
  ["../../src/storage/jsonl/node.ts", "@earendil-works/pi-durable/storage/jsonl/node"],
  ["../../src/env/node.ts", "@earendil-works/pi-durable/env/node"],
  ["../../src/tools/index.ts", "@earendil-works/pi-durable/tools"],
  ["../../src/index.ts", "@earendil-works/pi-durable"],
];

const response = await fetch(LIST_API, { headers: { "user-agent": "durable-pi" } });
if (!response.ok) throw new Error(`listing failed: HTTP ${response.status}`);
const names = (await response.json()).filter((entry) => entry.name.endsWith(".ts")).map((entry) => entry.name);

let fetched = 0;
for (const name of names.sort()) {
  const source = await fetch(`${UPSTREAM}/${name}`, { headers: { "user-agent": "durable-pi" } });
  if (!source.ok) throw new Error(`${name}: HTTP ${source.status}`);
  let text = await source.text();
  for (const [from, to] of REWRITE) text = text.split(`"${from}"`).join(`"${to}"`);
  writeFileSync(name, text);
  fetched++;
}

// Fail loudly if upstream added an import shape the table above does not cover.
const leftovers = [];
for (const name of readdirSync(".").filter((f) => /^\d\d-.*\.ts$/.test(f))) {
  const text = readFileSync(name, "utf8");
  for (const match of text.matchAll(/from\s+"(\.\.\/[^"]+)"/g)) leftovers.push(`${name} -> ${match[1]}`);
}
if (leftovers.length > 0)
  throw new Error(`unmapped relative imports, extend REWRITE:\n${leftovers.join("\n")}`);

console.log(`fetched and rewrote ${fetched} examples`);
