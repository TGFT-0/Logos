import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
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
  const children = [];
  function spawn() {
    const child = new EventEmitter();
    child.exitCode = null;
    child.signalCode = null;
    child.killed = false;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = new EventEmitter();
    child.stdin.writable = true;
    child.stdin.destroyed = false;
    child.requests = [];
    child.stdin.write = (line, callback) => {
      child.requests.push(JSON.parse(line));
      child.writeCallback = callback;
      return true;
    };
    child.kill = () => { child.killed = true; return true; };
    children.push(child);
    return child;
  }
  const module = { exports: {} };
  vm.runInNewContext(source, {
    module,
    Error,
    exports: module.exports,
    require: (id) => {
      if (id === "obsidian") {
        return { Plugin: class {}, ItemView: class {}, Modal: class {} };
      }
      if (id === "child_process") return { spawn };
      if (id === "@breezystack/lamejs") return {};
      return require(id);
    },
    console: { log() {}, warn() {}, error() {} }
  });
  const plugin = new module.exports.default();
  plugin.getWorkerEnv = () => ({});
  return {
    plugin,
    children,
    worker: () => plugin.ensurePersistentTtsWorker("/plugin", "node", "worker.cjs")
  };
}

const request = { pack: "kokoro-en", text: "Test", output: "/test.wav", sid: 0, speed: 1 };
const outcome = (promise) => promise.then(
  value => ({ value }), error => ({ error })
);
function respond(child, id = child.requests.at(-1).id) {
  child.stdout.emit("data", JSON.stringify({ id, success: true }) + "\n");
}

test("late close from cancelled worker preserves the replacement's request and partial response", { timeout: 1000 }, async () => {
  const { plugin, worker } = harness();
  const old = worker();
  const cancelled = outcome(plugin.sendPersistentTtsRequest(old, request));
  plugin.destroyPersistentTtsWorker("Cancelled");
  const next = worker();
  const result = outcome(plugin.sendPersistentTtsRequest(next, request));
  const line = JSON.stringify({ id: next.requests[0].id, success: true });
  next.stdout.emit("data", line.slice(0, 8));
  old.emit("close", null, "SIGTERM");
  assert.equal(plugin.pendingTtsRequests.size, 1);
  assert.equal(plugin.activeTtsChild, next);
  next.stdout.emit("data", line.slice(8) + "\n");
  assert.equal((await result).value.success, true);
  assert.equal((await cancelled).error.message, "Cancelled");
});

test("retired worker error and output cannot reject or resolve a new request", { timeout: 1000 }, async () => {
  const { plugin, worker } = harness();
  const old = worker();
  plugin.destroyPersistentTtsWorker();
  const next = worker();
  const result = outcome(plugin.sendPersistentTtsRequest(next, request));
  old.emit("error", new Error("Old process failure"));
  old.stdout.emit("data", '{"broken":');
  respond(old, next.requests[0].id);
  old.stderr.emit("data", "Old stderr");
  assert.equal(plugin.pendingTtsRequests.size, 1);
  assert.equal(plugin.activeTtsChild, next);
  respond(next);
  assert.equal((await result).value.success, true);
});

test("worker close rejects only requests owned by that worker", { timeout: 1000 }, async () => {
  const { plugin, worker } = harness();
  const old = worker();
  const oldResult = outcome(plugin.sendPersistentTtsRequest(old, request));
  old.killed = true;
  const next = worker();
  const nextResult = outcome(plugin.sendPersistentTtsRequest(next, request));
  old.emit("close", 1, null);
  assert.match((await oldResult).error.message, /exited with code 1/);
  assert.equal(plugin.pendingTtsRequests.size, 1);
  respond(next);
  assert.equal((await nextResult).value.success, true);
});

test("active worker crash rejects its requests and allows a replacement", { timeout: 1000 }, async () => {
  const { plugin, worker } = harness();
  const child = worker();
  assert.equal(worker(), child);
  const result = outcome(plugin.sendPersistentTtsRequest(child, request));
  child.stderr.emit("data", "Synthesis crashed");
  child.emit("close", 1, null);
  assert.equal((await result).error.message, "Synthesis crashed");
  assert.equal(plugin.pendingTtsRequests.size, 0);
  assert.notEqual(worker(), child);
});

test("asynchronous stdin callback failure settles the request", { timeout: 1000 }, async () => {
  const { plugin, worker } = harness();
  const child = worker();
  const result = outcome(plugin.sendPersistentTtsRequest(child, request));
  child.writeCallback(new Error("EPIPE"));
  assert.equal((await result).error.message, "EPIPE");
  assert.equal(plugin.pendingTtsRequests.size, 0);
});

test("stdin error rejects its requests; later retired stdin errors leave replacement alive", { timeout: 1000 }, async () => {
  const { plugin, worker } = harness();
  const old = worker();
  const result = outcome(plugin.sendPersistentTtsRequest(old, request));
  old.stdin.emit("error", new Error("Pipe closed"));
  assert.equal((await result).error.message, "Pipe closed");
  assert.equal(old.killed, true);
  const next = worker();
  const nextResult = outcome(plugin.sendPersistentTtsRequest(next, request));
  old.stdin.emit("error", new Error("Late pipe error"));
  assert.equal(plugin.pendingTtsRequests.size, 1);
  respond(next);
  assert.equal((await nextResult).value.success, true);
});

test("synchronous write failure leaves no pending request", { timeout: 1000 }, async () => {
  const { plugin, worker } = harness();
  const child = worker();
  child.stdin.write = () => { throw new Error("Write failed"); };
  const result = await outcome(plugin.sendPersistentTtsRequest(child, request));
  assert.equal(result.error.message, "Write failed");
  assert.equal(plugin.pendingTtsRequests.size, 0);
});

test("stopped or unwritable workers reject immediately without registering a request", { timeout: 1000 }, async () => {
  for (const stop of [
    child => { child.killed = true; },
    child => { child.exitCode = 1; },
    child => { child.signalCode = "SIGTERM"; },
    child => { child.stdin.destroyed = true; },
    child => { child.stdin.writable = false; }
  ]) {
    const { plugin, worker } = harness();
    const child = worker();
    stop(child);
    const result = await outcome(plugin.sendPersistentTtsRequest(child, request));
    assert.equal(result.error.message, "TTS worker is not available.");
    assert.equal(plugin.pendingTtsRequests.size, 0);
    assert.equal(child.requests.length, 0);
  }
});


test("healthy worker handles concurrent requests and batched responses", { timeout: 1000 }, async () => {
  const { plugin, worker } = harness();
  const child = worker();
  const first = outcome(plugin.sendPersistentTtsRequest(child, request));
  const second = outcome(plugin.sendPersistentTtsRequest(worker(), request));
  child.stdout.emit("data", child.requests.map(({ id }) =>
    JSON.stringify({ id, success: true })
  ).join("\n") + "\n");
  assert.equal((await first).value.success, true);
  assert.equal((await second).value.success, true);
  assert.equal(plugin.pendingTtsRequests.size, 0);
  assert.equal(plugin.activeTtsChild, child);
});


test("cancelled long-text playback handles an already rejected prefetch", { timeout: 1000 }, async () => {
  const { plugin } = harness();
  plugin.splitTextForSpeech = () => ["first", "second"];
  plugin.synthesizeSpeechChunk = async (text) => {
    if (text === "second") throw new Error("Prefetch cancelled");
    return "first.wav";
  };
  plugin.playSpeechChunk = async () => {
    // Let a failed prefetch settle while the previous chunk is still playing.
    await new Promise(resolve => setImmediate(resolve));
    plugin.stopSpeech();
    return false;
  };
  assert.equal(await plugin.speakLongText("Long text"), false);
});
