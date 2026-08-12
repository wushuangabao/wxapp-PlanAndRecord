function createdPlanTarget(result) {
  if (!result || typeof result !== 'object') return null;
  if (result.occurrence && typeof result.occurrence === 'object') return result.occurrence;
  if (result.event && typeof result.event === 'object') return result.event;
  return Number.isFinite(result.startedAt) && Number.isFinite(result.endedAt)
    ? result
    : null;
}

module.exports = { createdPlanTarget };
