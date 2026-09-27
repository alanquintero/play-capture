const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const contentScript = fs.readFileSync(path.join(__dirname, "..", "content.js"), "utf8");

function loadContentScript(video) {
  const documentListeners = new Map();
  let messageListener;
  const sentMessages = [];
  const timers = [];

  const context = {
    chrome: {
      runtime: {
        onMessage: {
          addListener(listener) {
            messageListener = listener;
          },
        },
        sendMessage(message) {
          sentMessages.push(message);
          return Promise.resolve({ ok: true });
        },
      },
    },
    document: {
      documentElement: {},
      addEventListener(type, listener) {
        documentListeners.set(type, listener);
      },
      querySelectorAll(selector) {
        return selector === "video" ? [video] : [];
      },
    },
    MutationObserver: class {
      observe() {}
      disconnect() {}
    },
    setTimeout(callback) {
      timers.push(callback);
      return timers.length;
    },
    clearTimeout(id) {
      timers[id - 1] = null;
    },
    Date,
    Number,
  };

  vm.runInNewContext(contentScript, context, { filename: "content.js" });

  return {
    arm() {
      messageListener({ type: "ARM_VIDEO", armedAt: Date.now() - 1000 }, {}, () => {});
    },
    dispatch(type) {
      documentListeners.get(type)({ target: video });
    },
    runTimers() {
      for (const timer of timers.splice(0)) timer?.();
    },
    sentMessages,
  };
}

function embeddedVideo(overrides = {}) {
  return {
    tagName: "VIDEO",
    paused: true,
    ended: false,
    readyState: 4,
    duration: 471.583333,
    currentTime: 20,
    getBoundingClientRect() {
      return { width: 740, height: 416 };
    },
    ...overrides,
  };
}

test("stops when the active embedded video fires ended", () => {
  const video = embeddedVideo();
  const page = loadContentScript(video);

  page.arm();
  video.paused = false;
  page.dispatch("play");
  video.ended = true;
  video.paused = true;
  page.dispatch("ended");

  assert.deepEqual(page.sentMessages.map((message) => message.type), ["VIDEO_STARTED", "VIDEO_ENDED"]);
});

test("stops when an embedded player pauses on its final frame", () => {
  const video = embeddedVideo();
  const page = loadContentScript(video);

  page.arm();
  video.paused = false;
  page.dispatch("play");
  video.currentTime = video.duration - 0.1;
  video.paused = true;
  page.dispatch("pause");

  assert.deepEqual(page.sentMessages.map((message) => message.type), ["VIDEO_STARTED", "VIDEO_ENDED"]);
});

test("pauses recording without stopping automatically", () => {
  const video = embeddedVideo();
  const page = loadContentScript(video);

  page.arm();
  video.paused = false;
  page.dispatch("play");
  video.currentTime = 55;
  video.paused = true;
  page.dispatch("pause");

  assert.deepEqual(page.sentMessages.map((message) => message.type), ["VIDEO_STARTED", "VIDEO_PAUSED"]);
});

test("remains paused until the video resumes or the user finishes", () => {
  const video = embeddedVideo();
  const page = loadContentScript(video);

  page.arm();
  video.paused = false;
  page.dispatch("play");
  video.currentTime = 55;
  video.paused = true;
  page.dispatch("pause");
  page.runTimers();

  assert.deepEqual(page.sentMessages.map((message) => message.type), ["VIDEO_STARTED", "VIDEO_PAUSED"]);
});

test("resumes recording when playback continues after a pause", () => {
  const video = embeddedVideo();
  const page = loadContentScript(video);

  page.arm();
  video.paused = false;
  page.dispatch("play");
  video.paused = true;
  page.dispatch("pause");
  video.paused = false;
  page.dispatch("play");
  assert.deepEqual(page.sentMessages.map((message) => message.type), [
    "VIDEO_STARTED",
    "VIDEO_PAUSED",
    "VIDEO_RESUMED",
  ]);
});

test("does not start the file before the video plays", () => {
  const page = loadContentScript(embeddedVideo());

  page.arm();

  assert.deepEqual(page.sentMessages, []);
});
