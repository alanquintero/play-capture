const OFFSCREEN_PATH = "offscreen/offscreen.html";

const DEFAULT_STATE = {
  status: "idle",
  tabId: null,
  tabTitle: "",
  startedAt: null,
  pausedAt: null,
  totalPausedMs: 0,
  error: "",
};

let creatingOffscreenDocument;

chrome.runtime.onInstalled.addListener(async (details) => {
  const current = await chrome.storage.session.get("captureState");
  if (!current.captureState) {
    await setCaptureState(DEFAULT_STATE);
  }
  if (details.reason === "install" || details.previousVersion === "0.3.1") {
    await chrome.storage.local.set({ outputFormat: "mp4" });
  }
});

chrome.runtime.onStartup.addListener(async () => {
  const state = await getCaptureState();
  if (["starting", "armed", "starting_recording", "recording", "paused_waiting", "stopping"].includes(state.status)) {
    await setCaptureState({
      ...DEFAULT_STATE,
      status: "error",
      error: "The previous recording was interrupted when Chrome closed.",
    });
    await setBadge("", "#c2410c");
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target === "offscreen") return false;

  handleMessage(message, sender)
    .then(sendResponse)
    .catch(async (error) => {
      const friendlyError = normalizeError(error);
      if (["START_RECORDING", "VIDEO_STARTED"].includes(message?.type)) {
        await setCaptureState({ ...DEFAULT_STATE, status: "error", error: friendlyError });
        await setBadge("!", "#c2410c");
      }
      sendResponse({ ok: false, error: friendlyError });
    });
  return true;
});

async function handleMessage(message, sender) {
  switch (message?.type) {
    case "GET_STATE":
      return {
        ok: true,
        capture: await getCaptureState(),
        recordings: await getRecordings(),
        outputFormat: await getOutputFormat(),
      };

    case "START_RECORDING":
      return startRecording(message.format);

    case "STOP_RECORDING":
      return stopRecording(message.reason || "manual");

    case "VIDEO_ENDED": {
      const state = await getCaptureState();
      if (["armed", "starting_recording", "recording", "paused_waiting"].includes(state.status) && sender.tab?.id === state.tabId) {
        return stopRecording(message.reason || "video-ended");
      }
      return { ok: true, ignored: true };
    }

    case "VIDEO_STARTED":
      return beginRecordingForVideo(sender);

    case "VIDEO_PAUSED":
      return pauseRecordingForVideo(sender);

    case "VIDEO_RESUMED":
      return resumeRecordingForVideo(sender);

    case "OFFSCREEN_RECORDING_STARTED":
      return markRecordingStarted(message);

    case "OFFSCREEN_RECORDING_READY":
      return markRecordingReady(message.recording);

    case "OFFSCREEN_RECORDING_ERROR":
      return markRecordingError(message.error);

    case "DOWNLOAD_RECORDING":
      await ensureOffscreenDocument();
      return downloadRecording(message.id);

    case "DELETE_RECORDING":
      await ensureOffscreenDocument();
      return deleteRecording(message.id);

    case "CLEAR_RECORDINGS":
      await ensureOffscreenDocument();
      return clearRecordings();

    case "CLEAR_ERROR":
      await setCaptureState(DEFAULT_STATE);
      await setBadge("", "#c2410c");
      return { ok: true };

    default:
      return { ok: false, error: "Unknown extension message." };
  }
}

async function startRecording(requestedFormat) {
  const state = await getCaptureState();
  if (["starting", "armed", "starting_recording", "recording", "paused_waiting", "stopping"].includes(state.status)) {
    throw new Error("A recording is already in progress.");
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("Chrome could not find the active tab.");
  if (!isCapturableUrl(tab.url)) {
    throw new Error("Chrome does not allow extensions to record this page. Open a normal website tab and try again.");
  }

  const outputFormat = requestedFormat === "mp4" ? "mp4" : "webm";
  await chrome.storage.local.set({ outputFormat });

  await setCaptureState({
    ...DEFAULT_STATE,
    status: "starting",
    tabId: tab.id,
    tabTitle: tab.title || "Recorded tab",
    startedAt: null,
  });
  await setBadge("…", "#d97706");
  await ensureOffscreenDocument();

  // Must run after the popup button click. The returned ID expires quickly and is
  // consumed immediately by the offscreen document.
  const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
  const response = await sendToOffscreen({
    type: "ARM_CAPTURE",
    streamId,
    tabId: tab.id,
    title: tab.title || "Recorded tab",
    sourceUrl: tab.url || "",
    outputFormat,
  });

  if (!response?.ok) throw new Error(response?.error || "The recorder could not arm.");

  await setCaptureState({
    ...DEFAULT_STATE,
    status: "armed",
    tabId: tab.id,
    tabTitle: tab.title || "Recorded tab",
  });
  await setBadge("WAIT", "#2563eb");

  // The content script starts MediaRecorder only after the lesson video plays.
  chrome.tabs.sendMessage(tab.id, { type: "ARM_VIDEO", armedAt: Date.now() }).catch(() => {});
  return { ok: true };
}

async function beginRecordingForVideo(sender) {
  const state = await getCaptureState();
  if (state.status !== "armed" || sender.tab?.id !== state.tabId) {
    return { ok: true, ignored: true };
  }

  await setCaptureState({ ...state, status: "starting_recording" });
  const response = await sendToOffscreen({ type: "BEGIN_RECORDING" });
  if (!response?.ok) throw new Error(response?.error || "The file recorder could not start.");
  return { ok: true };
}

async function pauseRecordingForVideo(sender) {
  const state = await getCaptureState();
  if (state.status !== "recording" || sender.tab?.id !== state.tabId) {
    return { ok: true, ignored: true };
  }

  const response = await sendToOffscreen({ type: "PAUSE_RECORDING" });
  if (!response?.ok) throw new Error(response?.error || "The file recorder could not pause.");
  await setCaptureState({ ...state, status: "paused_waiting", pausedAt: Date.now() });
  await setBadge("Ⅱ", "#d97706");
  return { ok: true };
}

async function resumeRecordingForVideo(sender) {
  const state = await getCaptureState();
  if (state.status !== "paused_waiting" || sender.tab?.id !== state.tabId) {
    return { ok: true, ignored: true };
  }

  const response = await sendToOffscreen({ type: "RESUME_RECORDING" });
  if (!response?.ok) throw new Error(response?.error || "The file recorder could not resume.");
  const pausedForMs = state.pausedAt ? Date.now() - state.pausedAt : 0;
  await setCaptureState({
    ...state,
    status: "recording",
    pausedAt: null,
    totalPausedMs: (state.totalPausedMs || 0) + pausedForMs,
  });
  await setBadge("REC", "#dc2626");
  return { ok: true };
}

async function stopRecording(reason) {
  const state = await getCaptureState();
  if (!["starting", "armed", "starting_recording", "recording", "paused_waiting"].includes(state.status)) {
    return { ok: true, ignored: true };
  }

  await setCaptureState({ ...state, status: "stopping" });
  await setBadge("…", "#d97706");
  const response = await sendToOffscreen({ type: "STOP_RECORDING", reason });
  if (!response?.ok) throw new Error(response?.error || "The recorder could not stop cleanly.");
  if (response.discarded) {
    await setCaptureState(DEFAULT_STATE);
    await setBadge("", "#047857");
  }
  return { ok: true };
}

async function markRecordingStarted(message) {
  const state = await getCaptureState();
  if (state.tabId !== message.tabId) return { ok: true, ignored: true };
  await setCaptureState({ ...state, status: "recording", startedAt: message.startedAt, error: "" });
  await setBadge("REC", "#dc2626");
  return { ok: true };
}

async function markRecordingReady(recording) {
  const recordings = await getRecordings();
  await chrome.storage.local.set({ recordings: [recording, ...recordings].slice(0, 50) });
  await setCaptureState(DEFAULT_STATE);
  await setBadge("1", "#047857");
  chrome.runtime.sendMessage({ type: "RECORDING_LIST_CHANGED" }).catch(() => {});
  return { ok: true };
}

async function markRecordingError(error) {
  await setCaptureState({ ...DEFAULT_STATE, status: "error", error: normalizeError(error) });
  await setBadge("!", "#c2410c");
  return { ok: true };
}

async function deleteRecording(id) {
  const result = await sendToOffscreen({ type: "DELETE_RECORDING", id });
  if (!result?.ok) return result;
  const recordings = (await getRecordings()).filter((recording) => recording.id !== id);
  await chrome.storage.local.set({ recordings });
  if (!recordings.length) await setBadge("", "#047857");
  return { ok: true };
}

async function clearRecordings() {
  const result = await sendToOffscreen({ type: "CLEAR_RECORDINGS" });
  if (!result?.ok) return result;
  await chrome.storage.local.set({ recordings: [] });
  await setBadge("", "#047857");
  return { ok: true };
}

async function downloadRecording(id) {
  const prepared = await sendToOffscreen({ type: "PREPARE_DOWNLOAD", id });
  if (!prepared?.ok) return prepared;
  const downloadId = await chrome.downloads.download({
    url: prepared.url,
    filename: prepared.filename,
    saveAs: true,
  });
  return { ok: true, downloadId };
}

async function ensureOffscreenDocument() {
  const url = chrome.runtime.getURL(OFFSCREEN_PATH);
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [url],
  });
  if (contexts.length) return;

  if (!creatingOffscreenDocument) {
    creatingOffscreenDocument = chrome.offscreen.createDocument({
      url: OFFSCREEN_PATH,
      reasons: ["USER_MEDIA", "BLOBS"],
      justification: "Record the selected tab and create a local downloadable video file.",
    }).finally(() => {
      creatingOffscreenDocument = null;
    });
  }
  await creatingOffscreenDocument;
}

function sendToOffscreen(message) {
  return chrome.runtime.sendMessage({ ...message, target: "offscreen" });
}

async function getCaptureState() {
  const { captureState } = await chrome.storage.session.get("captureState");
  return captureState || DEFAULT_STATE;
}

function setCaptureState(state) {
  return chrome.storage.session.set({ captureState: state });
}

async function getRecordings() {
  const { recordings = [] } = await chrome.storage.local.get("recordings");
  return recordings;
}

async function getOutputFormat() {
  const { outputFormat = "mp4" } = await chrome.storage.local.get("outputFormat");
  return outputFormat;
}

async function setBadge(text, color) {
  await chrome.action.setBadgeBackgroundColor({ color });
  await chrome.action.setBadgeText({ text });
}

function isCapturableUrl(url = "") {
  return /^(https?|file):/i.test(url);
}

function normalizeError(error) {
  const message = typeof error === "string" ? error : error?.message;
  if (!message) return "An unexpected recording error occurred.";
  if (message.includes("Cannot access")) return "Chrome blocked access to this tab.";
  if (message.includes("activeTab")) return "Click the extension on the tab you want to record, then try again.";
  return message;
}

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const state = await getCaptureState();
  if (state.tabId === tabId && ["starting", "armed", "starting_recording", "recording", "paused_waiting"].includes(state.status)) {
    await stopRecording("tab-closed").catch(() => {});
  }
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (changeInfo.status !== "complete") return;
  const state = await getCaptureState();
  if (state.tabId === tabId && ["armed", "starting_recording", "recording", "paused_waiting"].includes(state.status)) {
    chrome.tabs.sendMessage(tabId, { type: "ARM_VIDEO", armedAt: Date.now() }).catch(() => {});
  }
});
