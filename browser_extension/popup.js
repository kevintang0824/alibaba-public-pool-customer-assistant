document.getElementById("openPanel").addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  await chrome.tabs.sendMessage(tab.id, { type: "ACDA_SHOW_PANEL" }).catch(() => {});
  window.close();
});
