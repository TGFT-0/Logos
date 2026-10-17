import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import vm from "node:vm";
import { transformSync } from "esbuild";

const require = createRequire(import.meta.url);
const source = transformSync(
  readFileSync(new URL("../main.ts", import.meta.url), "utf8"),
  { loader: "ts", format: "cjs", target: "es2018" }
).code;

function harness() {
  const notices = [];
  const module = { exports: {} };
  vm.runInNewContext(source, {
    module, exports: module.exports, Error,
    require(id) {
      if (id === "obsidian") return {
        Plugin: class {}, ItemView: class {}, Modal: class {},
        Notice: class { constructor(message) { notices.push(message); } }
      };
      if (id === "@breezystack/lamejs") return {};
      return require(id);
    },
    document: {
      createDocumentFragment() {
        return {
          createSpan({ text }) { this.text = text; },
          createEl(tag, { text }) { this.button = { tag, text }; return this.button; }
        };
      }
    }
  });
  return { plugin: new module.exports.default(), notices };
}

test("error notice is concise while original diagnostics remain accessible through Help", () => {
  const { plugin, notices } = harness();
  const raw = "Error processing file '/usr/share/espeak-ng-data/phontab': No such file or directory.\nNative diagnostic stack";
  plugin.showTtsError(new Error(raw));
  assert.equal(plugin.lastTtsError.details, raw);
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
  plugin.showTtsError(new Error(raw));
  assert.match(notices[0].text, /missing or unreadable/);
  assert.doesNotMatch(notices[0].text, /fallback/);
  assert.equal(plugin.lastTtsError.details, raw);
});
