const elements = {
  statusDot: document.querySelector("#status-dot"),
  statusLabel: document.querySelector("#status-label"),
  statusDetail: document.querySelector("#status-detail"),
  timer: document.querySelector("#timer"),
  primaryButton: document.querySelector("#primary-button"),
  primaryLabel: document.querySelector("#primary-label"),
  outputFormat: document.querySelector("#output-format"),
  extensionEnabled: document.querySelector("#extension-enabled"),
  extensionState: document.querySelector("#extension-state"),
  downloadPending: document.querySelector("#download-pending"),
  clearRecordings: document.querySelector("#clear-recordings"),
  dismissError: document.querySelector("#dismiss-error"),
  count: document.querySelector("#recording-count"),
  empty: document.querySelector("#empty-state"),
  list: document.querySelector("#recording-list"),
};

let state = { capture: { status: "idle" }, recordings: [] };
let timerHandle;

elements.primaryButton.addEventListener("click", async () => {
  const active = ["starting", "armed", "starting_recording", "recording", "paused_waiting"].includes(state.capture.status);
  elements.primaryButton.disabled = true;
  const response = await sendMessage({
    type: active ? "STOP_RECORDING" : "START_RECORDING",
    format: elements.outputFormat.value,
  });
  if (!response?.ok) {
    state.capture = { status: "error", error: response?.error || "The command failed." };
    render();
  }
  await refresh();
});

elements.dismissError.addEventListener("click", async () => {
  await sendMessage({ type: "CLEAR_ERROR" });
  await refresh();
});

elements.outputFormat.addEventListener("change", () => {
  chrome.storage.local.set({ outputFormat: elements.outputFormat.value });
});

elements.extensionEnabled.addEventListener("change", async () => {
  elements.extensionEnabled.disabled = true;
  const enabled = elements.extensionEnabled.checked;
  const response = await sendMessage({ type: "SET_EXTENSION_ENABLED", enabled });
  if (!response?.ok) elements.extensionEnabled.checked = !enabled;
  await refresh();
});

elements.clearRecordings.addEventListener("click", async () => {
  if (!state.recordings?.length) return;
  if (!window.confirm("Remove all saved recordings from this extension? Downloaded files in your Downloads folder will stay untouched.")) return;
  elements.clearRecordings.disabled = true;
  const response = await sendMessage({ type: "CLEAR_RECORDINGS" });
  if (!response?.ok) {
    state.capture = { status: "error", error: response?.error || "The recordings could not be cleared." };
    render();
    return;
  }
  await refresh();
});

elements.downloadPending.addEventListener("click", async () => {
  elements.downloadPending.disabled = true;
  const response = await sendMessage({ type: "DOWNLOAD_PENDING_RECORDINGS" });
  if (!response?.ok) {
    state.capture = { status: "error", error: response?.error || "The downloads could not be started." };
    render();
    return;
  }
  await refresh();
});

elements.list.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  button.disabled = true;
  const message = {
    type: button.dataset.action === "download" ? "DOWNLOAD_RECORDING" : "DELETE_RECORDING",
    id: button.dataset.id,
  };
  const response = await sendMessage(message);
  if (!response?.ok) {
    state.capture = { status: "error", error: response?.error || "The command failed." };
    render();
    return;
  }
  await refresh();
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "RECORDING_LIST_CHANGED") refresh();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "session" && changes.captureState) refresh();
  if (area === "local" && (changes.recordings || changes.extensionEnabled)) refresh();
});

async function refresh() {
  const response = await sendMessage({ type: "GET_STATE" });
  if (response?.ok) {
    state = response;
    render();
  }
}

function render() {
  const capture = state.capture || { status: "idle" };
  const captureActive = ["starting", "armed", "starting_recording", "recording", "paused_waiting", "stopping"].includes(capture.status);
  const extensionEnabled = state.extensionEnabled !== false;
  elements.extensionEnabled.checked = extensionEnabled;
  elements.extensionEnabled.disabled = captureActive;
  elements.extensionState.textContent = extensionEnabled ? "On" : "Off";
  elements.primaryButton.disabled = !extensionEnabled || capture.status === "starting" || capture.status === "stopping";
  elements.outputFormat.disabled = !extensionEnabled || captureActive;
  if (!captureActive && state.outputFormat) elements.outputFormat.value = state.outputFormat;
  elements.primaryButton.classList.toggle("stop", ["armed", "starting_recording", "recording", "paused_waiting"].includes(capture.status));
  const dotState = capture.status === "recording"
    ? "recording"
    : capture.status === "paused_waiting"
      ? "paused"
    : capture.status === "armed"
      ? "armed"
      : capture.status === "error"
        ? "error"
        : "";
  elements.statusDot.className = `status-dot ${dotState}`;
  elements.timer.hidden = !["recording", "paused_waiting", "stopping"].includes(capture.status);
  elements.dismissError.hidden = capture.status !== "error";

  const display = !extensionEnabled && capture.status === "idle"
    ? ["Play Capture is off", "Turn it on when you want to record a tab.", "Start"]
    : ({
    idle: ["Ready to arm", "Click Start, then press Play on the video.", "Start"],
    starting: ["Preparing capture", "Chrome is connecting to this tab…", "Preparing…"],
    armed: ["Waiting for the video", "Press Play. The saved file will begin at the first video frame.", "Cancel"],
    starting_recording: ["Video detected", "Starting the file recorder…", "Stop"],
    recording: ["Recording this tab", capture.tabTitle || "Keep the video playing. Recording stops when it ends.", "Stop recording"],
    paused_waiting: ["Video paused", "Recording is paused. Press Finish now to save it, or resume the video to continue.", "Finish now"],
    stopping: ["Finishing file", "Saving the recording on this device…", "Finishing…"],
    error: ["Recording error", capture.error || "Something went wrong.", "Try again"],
    }[capture.status] || ["Ready to arm", "Click Start, then press Play on the video.", "Start"]);

  [elements.statusLabel.textContent, elements.statusDetail.textContent, elements.primaryLabel.textContent] = display;
  updateTimer();
  clearInterval(timerHandle);
  if (["recording", "paused_waiting", "stopping"].includes(capture.status)) timerHandle = setInterval(updateTimer, 1000);

  const recordings = state.recordings || [];
  elements.count.textContent = recordings.length;
  const pendingCount = recordings.filter((recording) => ["not_downloaded", "error"].includes(recording.downloadStatus || "not_downloaded")).length;
  elements.downloadPending.hidden = pendingCount === 0;
  elements.downloadPending.disabled = false;
  elements.downloadPending.textContent = `Download all (${pendingCount})`;
  elements.clearRecordings.hidden = recordings.length === 0;
  elements.clearRecordings.disabled = false;
  elements.empty.hidden = recordings.length > 0;
  elements.list.replaceChildren(...recordings.map(renderRecording));
}

function renderRecording(recording) {
  const item = document.createElement("article");
  item.className = "recording-item";

  const title = document.createElement("div");
  title.className = "recording-title";
  title.textContent = recording.title || recording.filename;
  title.title = recording.filename;

  const meta = document.createElement("div");
  meta.className = "recording-meta";
  const dimensions = recording.width && recording.height ? ` · ${recording.width}×${recording.height}` : "";
  meta.textContent = `${formatDuration(recording.durationMs)} · ${formatBytes(recording.size)}${dimensions}`;

  const downloadStatus = recording.downloadStatus || "not_downloaded";
  const status = document.createElement("div");
  status.className = `download-status ${downloadStatus}`;
  status.textContent = {
    not_downloaded: "Not downloaded",
    downloading: "Downloading…",
    downloaded: "Downloaded",
    error: "Download failed",
  }[downloadStatus] || "Not downloaded";
  if (downloadStatus === "error" && recording.downloadError) status.title = recording.downloadError;

  const actions = document.createElement("div");
  actions.className = "recording-actions";
  const format = recording.mimeType?.startsWith("video/mp4") ? "MP4" : "WebM";
  const downloadLabel = downloadStatus === "downloaded"
    ? `Download ${format} again`
    : downloadStatus === "error"
      ? `Retry ${format} download`
      : downloadStatus === "downloading"
        ? "Downloading…"
        : `Download ${format}`;
  const downloadButton = makeActionButton(downloadLabel, "download", recording.id);
  downloadButton.disabled = downloadStatus === "downloading";
  actions.append(
    downloadButton,
    makeActionButton("Remove", "remove", recording.id),
  );
  item.append(title, meta, status, actions);
  return item;
}

function makeActionButton(label, action, id) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = action;
  button.dataset.action = action;
  button.dataset.id = id;
  button.textContent = label;
  return button;
}

function updateTimer() {
  const capture = state.capture || {};
  const effectiveNow = capture.status === "paused_waiting" && capture.pausedAt
    ? capture.pausedAt
    : Date.now();
  const elapsed = capture.startedAt
    ? effectiveNow - capture.startedAt - (capture.totalPausedMs || 0)
    : 0;
  elements.timer.textContent = formatDuration(elapsed);
}

function formatDuration(milliseconds = 0) {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return hours
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
    : `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function formatBytes(bytes = 0) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index ? 1 : 0)} ${units[index]}`;
}

async function sendMessage(message) {
  try {
    return await chrome.runtime.sendMessage(message);
  } catch (error) {
    return { ok: false, error: error?.message || "The extension did not respond." };
  }
}

refresh();
