// The page script: a Refresh button that reads the extension's api and updates
// the table. It is a file on this origin, so the page policy lets it run.
const gib = (bytes) => `${(bytes / 1024 ** 3).toFixed(1)} GiB`;

function show(values) {
  const text = {
    hostUptimeSeconds: String(values.hostUptimeSeconds),
    load: values.load.join(", "),
    freeMemoryBytes: gib(values.freeMemoryBytes),
    totalMemoryBytes: gib(values.totalMemoryBytes),
    daemonUptimeSeconds: String(values.daemonUptimeSeconds),
  };
  for (const [field, value] of Object.entries(text)) {
    const cell = document.querySelector(`[data-field="${field}"]`);
    if (cell !== null) cell.textContent = value;
  }
}

document.getElementById("refresh")?.addEventListener("click", async () => {
  const response = await window.piSecPage.fetch("status");
  if (response.ok) show(await response.json());
});
