// Pawchive Creator Downloader - background
// Saves one file at a time for the page script and reports back when it has finished.

const api = globalThis.browser ?? globalThis.chrome;

// Give up waiting on a single file after this long and move on (it keeps downloading).
const WAIT_LIMIT_MS = 4 * 60 * 1000;

api.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.type !== 'pcd-download') return false;
  downloadAndWait(msg.url, msg.filename).then(sendResponse);
  return true; // respond asynchronously
});

function downloadAndWait(url, filename) {
  return new Promise((resolve) => {
    let id = null;
    let done = false;

    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      api.downloads.onChanged.removeListener(onChanged);
      resolve(result);
    };

    const fromState = (state, error) => {
      if (state === 'complete') finish({ ok: true });
      else if (state === 'interrupted') finish({ ok: false, error: error || 'Download interrupted' });
    };

    const onChanged = (delta) => {
      if (id === null || delta.id !== id || !delta.state) return;
      fromState(delta.state.current, delta.error && delta.error.current);
    };

    const timer = setTimeout(() => finish({ ok: true, slow: true }), WAIT_LIMIT_MS);
    api.downloads.onChanged.addListener(onChanged);

    Promise.resolve(
      api.downloads.download({ url, filename, conflictAction: 'uniquify', saveAs: false })
    )
      .then(async (newId) => {
        id = newId;
        // A small file can finish before we start listening for it.
        const [item] = await api.downloads.search({ id });
        if (item) fromState(item.state, item.error);
      })
      .catch((err) => finish({ ok: false, error: String((err && err.message) || err) }));
  });
}
