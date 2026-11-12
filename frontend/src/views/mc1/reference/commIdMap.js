
export const commIdByMessageId = new Map();

export function loadCommIdMap(obj) {
  commIdByMessageId.clear();
  for (const [mid, num] of Object.entries(obj || {})) {
    if (num != null) commIdByMessageId.set(mid, num);
  }
}

export function messageNumber(messageId) {
  if (!messageId) return null;
  const n = commIdByMessageId.get(messageId);
  return n == null ? null : n;
}
