// The harness a device runs, and how a host opens storage for it, in one place.
//
// This exists because of module identity. pi-durable identifies its own objects by construction
// (`view.ts` refuses a harness it did not build), and this repo installs each app separately, so a
// Worker that imports routes.ts from apps/dpi-backend AND its own store from
// apps/pi-durable-cloudflare would bundle two copies of the library: the store would build a
// harness with one copy and streams.ts would hand it to the other, which answers "Not a Harness".
//
// A host therefore never imports pi-durable itself. It takes everything it needs to open a harness
// from here, so both sides of that check are the same module instance.
export { Harness, createRegistry } from "@earendil-works/pi-durable";
export { openDurableObjectSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
export { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
export { createModels } from "@earendil-works/pi-ai";
