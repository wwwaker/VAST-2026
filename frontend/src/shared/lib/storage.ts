/** Browser preferences are optional; denied storage must not prevent opening a workspace. */
export function readStoredValue(key: string) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeStoredValue(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Keep the current tab usable even when the browser cannot persist preferences.
  }
}
