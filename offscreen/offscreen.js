const DB_NAME = "play-and-save-video";
const DB_VERSION = 1;
const STORE_NAME = "recordings";

let session = null;
let audioContext = null;

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target !== "offscreen") return false;
  handleMessage(message).then(sendResponse).catch((error) => {
    sendResponse({ ok: false, error: error?.message || String(error) });
  });
  return true;
});

async function handleMessage(message) {
  switch (message.type) {
    case "ARM_CAPTURE":
      return armCapture(message);
    case "BEGIN_RECORDING":
      return beginRecording();
    case "PAUSE_RECORDING":
      return pauseRecording();
    case "RESUME_RECORDING":
      return resumeRecording();
    case "STOP_RECORDING":
      return stopRecording(message.reason || "manual");
    case "PREPARE_DOWNLOAD":
      return prepareDownload(message.id);
    case "DELETE_RECORDING":
      await deleteFromDatabase(message.id);
      return { ok: true };
    case "CLEAR_RECORDINGS":
      await clearDatabase();
      return { ok: true };
    default:
      return { ok: false, error: "Unknown recorder command." };
  }
}

async function armCapture({ streamId, tabId, title, sourceUrl, outputFormat }) {
  if (session) throw new Error("The recorder is already active.");

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: "tab",
          chromeMediaSourceId: streamId,
        },
      },
      video: {
        mandatory: {
          chromeMediaSource: "tab",
          chromeMediaSourceId: streamId,
        },
      },
    });

    if (!stream.getAudioTracks().length) {
      throw new Error("Chrome did not provide an audio track for this tab.");
    }

    // Keep playback on the original tab stream, but present MediaRecorder with
    // video first and audio second. Some desktop MP4 players are sensitive to
    // the track order emitted by tab capture.
    const recordingStream = new MediaStream([
      ...stream.getVideoTracks(),
      ...stream.getAudioTracks(),
    ]);

    // Tab capture mutes the tab by default. Route the captured sound back to the
    // user's speakers while recording, as recommended by Chrome's documentation.
    if (stream.getAudioTracks().length) {
      audioContext = new AudioContext();
      audioContext.createMediaStreamSource(stream).connect(audioContext.destination);
      if (audioContext.state === "suspended") await audioContext.resume();
    }

    const mimeType = chooseMimeType(outputFormat);
    const recorder = mimeType
      ? new MediaRecorder(recordingStream, {
        mimeType,
        videoBitsPerSecond: 5_000_000,
        audioBitsPerSecond: 192_000,
      })
      : new MediaRecorder(recordingStream, { audioBitsPerSecond: 192_000 });

    session = {
      recorder,
      stream,
      recordingStream,
      chunks: [],
      tabId,
      title,
      sourceUrl,
      startedAt: null,
      pauseStartedAt: null,
      totalPausedMs: 0,
      stopReason: "manual",
    };

    recorder.addEventListener("dataavailable", (event) => {
      if (event.data?.size) session?.chunks.push(event.data);
    });
    recorder.addEventListener("stop", finishRecording, { once: true });
    recorder.addEventListener("error", (event) => failRecording(event.error), { once: true });
    recordingStream.getTracks().forEach((track) => {
      track.addEventListener("ended", () => {
        if (["recording", "paused"].includes(session?.recorder.state)) stopRecording("stream-ended");
      }, { once: true });
    });

    return { ok: true, mimeType: recorder.mimeType || mimeType };
  } catch (error) {
    stream?.getTracks().forEach((track) => track.stop());
    cleanupSession();
    await notifyBackground({ type: "OFFSCREEN_RECORDING_ERROR", error: error.message });
    throw error;
  }
}

async function beginRecording() {
  if (!session) throw new Error("The tab capture is not armed.");
  if (session.recorder.state !== "inactive") return { ok: true, ignored: true };

  session.startedAt = Date.now();
  // A single finalized Blob is more compatible with desktop MP4 players than
  // joining one-second fragmented MP4 chunks.
  session.recorder.start();
  await notifyBackground({
    type: "OFFSCREEN_RECORDING_STARTED",
    tabId: session.tabId,
    startedAt: session.startedAt,
  });
  return { ok: true };
}

function pauseRecording() {
  if (!session || session.recorder.state !== "recording") return { ok: true, ignored: true };
  session.pauseStartedAt = Date.now();
  session.recorder.pause();
  return { ok: true };
}

function resumeRecording() {
  if (!session || session.recorder.state !== "paused") return { ok: true, ignored: true };
  if (session.pauseStartedAt) {
    session.totalPausedMs += Date.now() - session.pauseStartedAt;
    session.pauseStartedAt = null;
  }
  session.recorder.resume();
  return { ok: true };
}

async function stopRecording(reason) {
  if (!session) return { ok: true, ignored: true };
  session.stopReason = reason;
  if (["recording", "paused"].includes(session.recorder.state)) {
    session.recorder.stop();
    return { ok: true };
  }
  cleanupSession();
  return { ok: true, discarded: true };
}

async function finishRecording() {
  if (!session) return;
  const finished = session;
  const endedAt = Date.now();
  const finalPauseMs = finished.pauseStartedAt ? endedAt - finished.pauseStartedAt : 0;
  const pausedMs = finished.totalPausedMs + finalPauseMs;
  const actualMimeType = finished.recorder.mimeType || "video/webm";
  const blob = new Blob(finished.chunks, { type: actualMimeType });
  const id = crypto.randomUUID();
  const filename = buildFilename(finished.title, finished.startedAt, actualMimeType);
  const videoTrack = finished.stream.getVideoTracks()[0];
  const settings = videoTrack?.getSettings?.() || {};

  const recording = {
    id,
    filename,
    title: finished.title,
    sourceUrl: finished.sourceUrl,
    createdAt: finished.startedAt,
    durationMs: Math.max(0, endedAt - finished.startedAt - pausedMs),
    size: blob.size,
    mimeType: actualMimeType,
    width: settings.width || null,
    height: settings.height || null,
    stopReason: finished.stopReason,
  };

  try {
    await saveToDatabase({ ...recording, blob });
    cleanupSession();
    await notifyBackground({ type: "OFFSCREEN_RECORDING_READY", recording });
  } catch (error) {
    cleanupSession();
    await notifyBackground({ type: "OFFSCREEN_RECORDING_ERROR", error: error.message });
  }
}

async function failRecording(error) {
  const message = error?.message || "MediaRecorder stopped because of an unknown error.";
  cleanupSession();
  await notifyBackground({ type: "OFFSCREEN_RECORDING_ERROR", error: message });
}

function cleanupSession() {
  if (session?.stream) session.stream.getTracks().forEach((track) => track.stop());
  if (session?.recordingStream) session.recordingStream.getTracks().forEach((track) => track.stop());
  session = null;
  if (audioContext) audioContext.close().catch(() => {});
  audioContext = null;
}

function chooseMimeType(outputFormat) {
  const mp4Types = [
    "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
    "video/mp4;codecs=avc1.42E01E,opus",
    "video/mp4",
  ];
  const webmTypes = [
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm",
  ];
  const candidates = outputFormat === "mp4" ? [...mp4Types, ...webmTypes] : webmTypes;
  return candidates.find((type) => MediaRecorder.isTypeSupported(type)) || "";
}

async function prepareDownload(id) {
  const record = await getFromDatabase(id);
  if (!record?.blob) throw new Error("The saved recording could not be found.");

  const url = URL.createObjectURL(record.blob);
  // The service worker owns chrome.downloads. Keep this Blob URL alive long
  // enough for Chrome's download manager to open it.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return { ok: true, url, filename: record.filename };
}

function buildFilename(title, timestamp, mimeType) {
  const safeTitle = String(title || "video")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100) || "video";
  const date = new Date(timestamp).toISOString().replace(/[:.]/g, "-");
  const extension = mimeType.startsWith("video/mp4") ? "mp4" : "webm";
  return `${safeTitle} ${date}.${extension}`;
}

function notifyBackground(message) {
  return chrome.runtime.sendMessage({ ...message, target: "background" }).catch(() => null);
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function runTransaction(mode, operation) {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, mode);
    const request = operation(transaction.objectStore(STORE_NAME));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    transaction.oncomplete = () => database.close();
    transaction.onerror = () => reject(transaction.error);
  });
}

function saveToDatabase(record) {
  return runTransaction("readwrite", (store) => store.put(record));
}

function getFromDatabase(id) {
  return runTransaction("readonly", (store) => store.get(id));
}

function deleteFromDatabase(id) {
  return runTransaction("readwrite", (store) => store.delete(id));
}

function clearDatabase() {
  return runTransaction("readwrite", (store) => store.clear());
}
