import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import vm from "node:vm";
import { EventEmitter } from "node:events";
import { transformSync } from "esbuild";

const require = createRequire(import.meta.url);
const source = transformSync(
  readFileSync(new URL("../main.ts", import.meta.url), "utf8"),
  { loader: "ts", format: "cjs", target: "es2018" }
).code;

function harness(copyFails = false) {
  const notices = [];
  const modals = [];
  const copied = [];
  class Element {
    constructor(tag, options = {}) { this.tag = tag; this.textContent = options.text || ""; this.children = []; }
    empty() { this.children = []; }
    setText(text) { this.textContent = text; }
    createEl(tag, options) { const el = new Element(tag, options); this.children.push(el); return el; }
    createDiv(options) { return this.createEl("div", options); }
    all() { return [this, ...this.children.flatMap(el => el.all())]; }
  }
  function spawn() {
    const child = new EventEmitter();
    Object.assign(child, { pid: 123, exitCode: null, signalCode: null, killed: false });
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.stdin = new EventEmitter();
    Object.assign(child.stdin, { writable: true, destroyed: false, write() {} });
    child.kill = () => { child.killed = true; return true; };
    return child;
  }
  const module = { exports: {} };
  vm.runInNewContext(source, {
    module, exports: module.exports, Error,
    require(id) {
      if (id === "obsidian") return {
        Plugin: class {}, ItemView: class {}, Modal: class {
          constructor() { this.contentEl = new Element("div"); }
          open() { modals.push(this); this.onOpen(); }
        },
        Notice: class { constructor(message) { notices.push(message); } }
      };
      if (id === "child_process") return { spawn };
      if (id === "@breezystack/lamejs") return {};
      return require(id);
    },
    console: { log() {}, warn() {}, error() {} },
    navigator: { clipboard: { async writeText(text) {
      if (copyFails) throw new Error("Clipboard unavailable");
      copied.push(text);
    } } },
    document: {
      createDocumentFragment() {
        return {
          createSpan({ text }) { this.text = text; },
          createEl(tag, { text }) { this.button = { tag, text }; return this.button; }
        };
      }
    }
  });
  return { plugin: new module.exports.default(), notices, modals, copied };
}

test("error notice is concise while original diagnostics remain accessible through Help", () => {
  const { plugin, notices } = harness();
  const raw = "Error processing file '/usr/share/espeak-ng-data/phontab': No such file or directory.\nNative diagnostic stack";
  const error = new Error(raw);
  plugin.showTtsError(error);
  assert.equal(plugin.lastTtsError.details, error.stack);
  assert.doesNotMatch(notices[0].text, /Native diagnostic stack|phontab/);
  assert.match(notices[0].text, /fallback/);
  let helpOpened = false;
  plugin.openTtsHelp = () => { helpOpened = true; };
  notices[0].button.onclick();
  assert.equal(helpOpened, true);
});

test("confirmed missing files take priority over a native-path guess", () => {
  const { plugin, notices } = harness();
  const raw = "Model files are missing or unreadable.\n/vault/models/kokoro-en-v0_19/espeak-ng-data/phontab";
  const error = new Error(raw);
  plugin.showTtsError(error);
  assert.match(notices[0].text, /missing or unreadable/);
  assert.doesNotMatch(notices[0].text, /fallback/);
  assert.equal(plugin.lastTtsError.details, error.stack);
});


test("Help retains JS stack, nested cause and bounded recent session logs", () => {
  const { plugin } = harness();
  const cause = new Error("EACCES original reason");
  const error = new Error("Speech failed", { cause });
  cause.cause = error; // A circular cause must not hang diagnostic formatting.
  plugin.showTtsError(error);
  assert.ok(plugin.lastTtsError.details.includes(error.stack));
  assert.ok(plugin.lastTtsError.details.includes(cause.stack));
  assert.match(plugin.getTtsLogText(), /EACCES original reason/);
  for (let i = 0; i < 110; i++) plugin.recordTtsLog(`entry-${i}`);
  assert.equal(plugin.ttsLogs.length, 100);
  assert.match(plugin.getTtsLogText(), /Older log content omitted/);
  assert.doesNotMatch(plugin.getTtsLogText(), /entry-0\n/);
  assert.match(plugin.getTtsLogText(), /entry-109/);
  plugin.recordTtsLog("X".repeat(120000) + "end-marker");
  assert.ok(plugin.ttsLogs.join("\n").length <= 100000);
  assert.match(plugin.getTtsLogText(), /end-marker$/);
  plugin.clearTtsLogs();
  assert.equal(plugin.getTtsLogText(), "No speech logs in this session.");
  assert.equal(harness().plugin.getTtsLogText(), "No speech logs in this session.");
});


test("Help log controls refresh, copy current contents and clear without rendering HTML", async () => {
  const { plugin, modals, copied } = harness();
  plugin.recordTtsLog("<img src=x onerror=alert(1)>");
  plugin.openTtsHelp();
  const elements = modals[0].contentEl.all();
  const button = text => elements.find(el => el.tag === "button" && el.textContent === text);
  const output = elements.find(el => el.tag === "pre");
  assert.match(output.textContent, /<img src=x/);
  assert.equal(elements.filter(el => el.tag === "img").length, 0);
  plugin.recordTtsLog("arrived after opening");
  button("Refresh logs").onclick();
  assert.match(output.textContent, /arrived after opening/);
  plugin.recordTtsLog("arrived before copy");
  await button("Copy logs").onclick();
  assert.match(copied[0], /arrived before copy/);
  button("Clear logs").onclick();
  assert.equal(output.textContent, "No speech logs in this session.");
});

test("clipboard failure is handled with selectable-text fallback", async () => {
  const { plugin, modals, notices } = harness(true);
  plugin.openTtsHelp();
  await modals[0].contentEl.all().find(el => el.textContent === "Copy logs").onclick();
  assert.ok(notices.includes("Could not copy logs. Select and copy the text below."));
});

test("session logs capture retired native output, process errors and close", () => {
  const { plugin } = harness();
  plugin.getWorkerEnv = () => ({});
  const old = plugin.ensurePersistentTtsWorker("/plugin", "node", "worker");
  old.exitCode = 1;
  const replacement = plugin.ensurePersistentTtsWorker("/plugin", "node", "worker");
  old.stderr.emit("data", "late native diagnostic");
  old.emit("error", new Error("retired worker failure"));
  old.emit("close", 1, null);
  assert.match(plugin.getTtsLogText(), /late native diagnostic/);
  assert.match(plugin.getTtsLogText(), /retired worker failure/);
  assert.match(plugin.getTtsLogText(), /closed: code 1/);
  assert.equal(plugin.activeTtsChild, replacement);
});
