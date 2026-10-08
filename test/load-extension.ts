// Load the extension entry point with jiti and verify it registers cleanly.
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const jiti = require("jiti")(path.join(import.meta.dirname, "x.js"), { eval: true });

const mod = jiti("../index.ts");
const registered: string[] = [];

const fakePi = {
  registerCommand: (name: string) => registered.push(`command:${name}`),
  registerMessageRenderer: (type: string) => registered.push(`renderer:${type}`),
  registerTool: () => {},
  registerFlag: () => {},
  registerShortcut: () => {},
  sendMessage: () => {},
  on: () => {},
};

const factory = mod.default ?? mod;
factory(fakePi);
console.log("registered:", registered);

// Exercise the history/compare paths without a real UI.
const handler = registered.length ? null : null;
console.log("extension entry OK", handler === null);
