const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const backgroundScript = fs.readFileSync(path.join(__dirname, "..", "background.js"), "utf8");

function event() {
  let listener;
  return {
    addListener(callback) {
      listener = callback;
    },
    fire(...args) {
      return listener?.(...args);
    },
  };
}

function loadBackground(initialRecordings, downloadImpl = async () => 101) {
  const local = { recordings: structuredClone(initialRecordings) };
  const session = {};
  const runtimeMessages = event();
  const downloadChanges = event();
  const downloadCalls = [];
  const scriptCalls = [];

  const storageArea = (data) => ({
    async get(key) {
      if (typeof key === "string") return { [key]: structuredClone(data[key]) };
      return structuredClone(data);
    },
    async set(values) {
      Object.assign(data, structuredClone(values));
    },
  });

  const chrome = {
    action: {
      setBadgeBackgroundColor: async () => {},
      setBadgeText: async () => {},
    },
    downloads: {
      async download(options) {
        downloadCalls.push(structuredClone(options));
        return downloadImpl(options, downloadCalls.length);
      },
      onChanged: downloadChanges,
    },
    offscreen: { createDocument: async () => {} },
    runtime: {
      getContexts: async () => [{}],
      getURL: (value) => value,
      onInstalled: event(),
      onMessage: runtimeMessages,
      onStartup: event(),
      sendMessage: async (message) => {
        if (message.target === "offscreen" && message.type === "PREPARE_DOWNLOAD") {
          return { ok: true, url: `blob:${message.id}`, filename: `${message.id}.mp4` };
        }
        return { ok: true };
      },
    },
    storage: {
      local: storageArea(local),
      session: storageArea(session),
    },
    scripting: {
      async executeScript(options) {
        scriptCalls.push(structuredClone(options));
        return [];
      },
    },
    tabCapture: { getMediaStreamId: async () => "stream" },
    tabs: {
      onRemoved: event(),
      onUpdated: event(),
      query: async () => [],
      sendMessage: async () => {},
    },
  };

  const context = { chrome, Date, Error, Map, Number, Promise, RegExp };
  vm.runInNewContext(backgroundScript, context, { filename: "background.js" });

  return { chrome, context, downloadCalls, downloadChanges, local, scriptCalls };
}

function recording(id, downloadStatus) {
  return { id, filename: `${id}.mp4`, downloadStatus };
}

test("treats recordings saved before download tracking as not downloaded", async () => {
  const app = loadBackground([{ id: "old", filename: "old.mp4" }]);

  const recordings = await app.context.getRecordings();

  assert.equal(recordings[0].downloadStatus, "not_downloaded");
});

test("marks an individual recording downloaded only after Chrome completes it", async () => {
  const app = loadBackground([recording("one", "not_downloaded")]);

  await app.context.downloadRecording("one");
  assert.equal(app.local.recordings[0].downloadStatus, "downloading");
  assert.equal(app.downloadCalls[0].saveAs, true);

  await app.downloadChanges.fire({ id: 101, state: { current: "complete" } });

  assert.equal(app.local.recordings[0].downloadStatus, "downloaded");
  assert.equal(typeof app.local.recordings[0].downloadedAt, "number");
  assert.deepEqual(app.local.pendingDownloads, {});
});

test("stores a failed status when Chrome interrupts a download", async () => {
  const app = loadBackground([recording("one", "not_downloaded")]);
  await app.context.downloadRecording("one");

  await app.downloadChanges.fire({
    id: 101,
    state: { current: "interrupted" },
    error: { current: "NETWORK_FAILED" },
  });

  assert.equal(app.local.recordings[0].downloadStatus, "error");
  assert.equal(app.local.recordings[0].downloadError, "NETWORK_FAILED");
  assert.deepEqual(app.local.pendingDownloads, {});
});

test("bulk download starts only unfinished recordings without save dialogs", async () => {
  const app = loadBackground([
    recording("new", "not_downloaded"),
    recording("failed", "error"),
    recording("done", "downloaded"),
    recording("active", "downloading"),
  ], async (_options, callNumber) => 100 + callNumber);

  const result = await app.context.downloadPendingRecordings();

  assert.equal(result.started, 2);
  assert.equal(result.failed, 0);
  assert.deepEqual(app.downloadCalls.map((call) => call.filename), ["new.mp4", "failed.mp4"]);
  assert.ok(app.downloadCalls.every((call) => call.saveAs === false));
});

test("bulk download continues after one recording fails to start", async () => {
  const app = loadBackground([
    recording("first", "not_downloaded"),
    recording("second", "not_downloaded"),
  ], async (_options, callNumber) => {
    if (callNumber === 1) throw new Error("Disk is full");
    return 102;
  });

  const result = await app.context.downloadPendingRecordings();

  assert.equal(result.started, 1);
  assert.equal(result.failed, 1);
  assert.equal(app.local.recordings[0].downloadStatus, "error");
  assert.equal(app.local.recordings[1].downloadStatus, "downloading");
});

test("keeps the extension enabled by default and remembers when it is turned off", async () => {
  const app = loadBackground([]);

  assert.equal(await app.context.getExtensionEnabled(), true);
  await app.context.setExtensionEnabled(false);

  assert.equal(app.local.extensionEnabled, false);
  assert.equal(await app.context.getExtensionEnabled(), false);
});

test("does not start a recording while the extension is off", async () => {
  const app = loadBackground([]);
  app.local.extensionEnabled = false;

  await assert.rejects(
    app.context.startRecording("mp4"),
    /Play Capture is off/,
  );
});

test("loads the page monitor only when a recording starts", async () => {
  const app = loadBackground([]);
  app.chrome.tabs.query = async () => [{ id: 7, url: "https://example.com/lesson", title: "Lesson" }];

  assert.equal(app.scriptCalls.length, 0);
  await app.context.startRecording("mp4");

  assert.deepEqual(app.scriptCalls, [{
    target: { tabId: 7, allFrames: true },
    files: ["content.js"],
  }]);
});
