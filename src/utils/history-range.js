'use strict';

// Shared preset windows for the battery-history graphs (Network tab node
// history + participant tracker history). Keeping this in one place means
// both routes and the frontend agree on the same key set.
const HISTORY_RANGES = { '1h': 3600, '12h': 43200, '24h': 86400, '3d': 259200, '7d': 604800 };
const DEFAULT_HISTORY_RANGE = '24h';

function historySince(rangeKey) {
  const seconds = HISTORY_RANGES[rangeKey] || HISTORY_RANGES[DEFAULT_HISTORY_RANGE];
  return Math.floor(Date.now() / 1000) - seconds;
}

module.exports = { HISTORY_RANGES, DEFAULT_HISTORY_RANGE, historySince };
