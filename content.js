(() => {
  if (globalThis.playCaptureContentScriptLoaded) return;
  globalThis.playCaptureContentScriptLoaded = true;

  let armed = false;
  let activeVideo = null;
  let recordingActive = false;
  let disappearanceTimer = null;
  let pausedWaiting = false;
  let observer = null;
  let listenersAttached = false;

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "DISARM_VIDEO") {
      disarmVideoMonitor();
      sendResponse({ ok: true });
      return false;
    }
    if (message?.type !== "ARM_VIDEO") return false;
    armed = true;
    recordingActive = false;
    clearDisappearanceTimer();
    pausedWaiting = false;
    activeVideo = choosePlayingVideo();
    attachVideoListeners();
    observeVideos();
    if (activeVideo) notifyVideoStarted();
    sendResponse({ ok: true, watching: Boolean(activeVideo) });
    return false;
  });

  function attachVideoListeners() {
    if (listenersAttached) return;
    document.addEventListener("play", onPlay, true);
    document.addEventListener("ended", onEnded, true);
    document.addEventListener("pause", onPause, true);
    listenersAttached = true;
  }

  function disarmVideoMonitor() {
    armed = false;
    recordingActive = false;
    activeVideo = null;
    pausedWaiting = false;
    clearDisappearanceTimer();
    observer?.disconnect();
    observer = null;
    if (!listenersAttached) return;
    document.removeEventListener("play", onPlay, true);
    document.removeEventListener("ended", onEnded, true);
    document.removeEventListener("pause", onPause, true);
    listenersAttached = false;
  }

function onPlay(event) {
  if (!armed || event.target?.tagName !== "VIDEO") return;
  clearDisappearanceTimer();
  const wasWaitingOnPause = pausedWaiting;
  pausedWaiting = false;
  if (!activeVideo || videoArea(event.target) >= videoArea(activeVideo)) {
    activeVideo = event.target;
  }
  if (event.target !== activeVideo) return;
  if (!recordingActive) notifyVideoStarted();
  else if (wasWaitingOnPause) chrome.runtime.sendMessage({ type: "VIDEO_RESUMED" }).catch(() => {});
}

function onEnded(event) {
  if (!armed || event.target?.tagName !== "VIDEO") return;
  if (activeVideo && event.target !== activeVideo) return;
  disarmVideoMonitor();
  chrome.runtime.sendMessage({ type: "VIDEO_ENDED", reason: "video-ended" }).catch(() => {});
}

function notifyVideoStarted() {
  recordingActive = true;
  chrome.runtime.sendMessage({ type: "VIDEO_STARTED" })
    .then((response) => {
      if (!response?.ok) recordingActive = false;
    })
    .catch(() => {
      recordingActive = false;
    });
}

function onPause(event) {
  if (!armed || event.target?.tagName !== "VIDEO" || event.target !== activeVideo) return;
  const video = event.target;
  // Some embedded players pause on the last frame without forwarding `ended`.
  // Treat a pause within 250ms of a finite duration as completion.
  if (Number.isFinite(video.duration) && video.duration > 0 && video.duration - video.currentTime <= 0.25) {
    onEnded(event);
    return;
  }

  if (!recordingActive) return;
  pausedWaiting = true;
  chrome.runtime.sendMessage({ type: "VIDEO_PAUSED" }).catch(() => {});
}

function choosePlayingVideo() {
  return [...document.querySelectorAll("video")]
    .filter((video) => !video.paused && !video.ended && video.readyState > 1)
    .sort((a, b) => videoArea(b) - videoArea(a))[0] || null;
}

function videoArea(video) {
  const rect = video.getBoundingClientRect();
  return Math.max(0, rect.width) * Math.max(0, rect.height);
}

function observeVideos() {
  // Play and ended events are captured at document level. The observer also
  // notices players created after recording starts and selects one already playing.
  observer?.disconnect();
  observer = new MutationObserver(() => {
    if (!armed) {
      observer.disconnect();
      observer = null;
      return;
    }
    if (activeVideo?.isConnected === false) {
      const replacement = choosePlayingVideo();
      if (replacement) {
        activeVideo = replacement;
        clearDisappearanceTimer();
      } else {
        scheduleVideoDisappearance();
      }
    } else if (!activeVideo) {
      activeVideo = choosePlayingVideo();
      if (activeVideo && !recordingActive) notifyVideoStarted();
    }
  });
  observer.observe(document.documentElement || document, { childList: true, subtree: true });
}

function scheduleVideoDisappearance() {
  if (disappearanceTimer) return;
  disappearanceTimer = setTimeout(() => {
    disappearanceTimer = null;
    if (!armed || activeVideo?.isConnected !== false) return;
    disarmVideoMonitor();
    chrome.runtime.sendMessage({ type: "VIDEO_ENDED", reason: "video-disappeared" }).catch(() => {});
  }, 3000);
}

function clearDisappearanceTimer() {
  if (!disappearanceTimer) return;
  clearTimeout(disappearanceTimer);
  disappearanceTimer = null;
}
})();
