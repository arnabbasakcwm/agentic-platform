/** Save a file the page received (an export) with the browser's normal download. */
export function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.rel = "noopener";
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Revoked after the click has been handled, so the download has the data.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
