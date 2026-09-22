(function exposeCountdown(root, factory) {
  const api = factory();

  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.OneOfUsCountdown = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  const SECOND_MS = 1000;

  function getNextUtcMidnight(now = Date.now()) {
    const current = new Date(now);
    return Date.UTC(
      current.getUTCFullYear(),
      current.getUTCMonth(),
      current.getUTCDate() + 1,
      0,
      0,
      0,
      0,
    );
  }

  function getRemainingSeconds(now = Date.now(), getNextDrawAt = getNextUtcMidnight) {
    const nextDrawAt = getNextDrawAt(now);
    return Math.max(0, Math.ceil((nextDrawAt - now) / SECOND_MS));
  }

  function formatCountdown(totalSeconds) {
    const safeSeconds = Math.max(0, Math.floor(totalSeconds));
    const hours = String(Math.floor(safeSeconds / 3600)).padStart(2, '0');
    const minutes = String(Math.floor((safeSeconds % 3600) / 60)).padStart(2, '0');
    const seconds = String(safeSeconds % 60).padStart(2, '0');

    return `${hours}:${minutes}:${seconds}`;
  }

  function getCountdownText(now = Date.now(), getNextDrawAt = getNextUtcMidnight) {
    return formatCountdown(getRemainingSeconds(now, getNextDrawAt));
  }

  return {
    formatCountdown,
    getCountdownText,
    getNextUtcMidnight,
    getRemainingSeconds,
  };
});
