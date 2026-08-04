export async function runPruneEvents({ repos, retentionDays, logger = console }) {
  const deleted = await repos.events.pruneOlderThan(retentionDays);
  logger.info(`[prune_events] đã xóa ${deleted} sự kiện cũ hơn ${retentionDays} ngày`);
  return { deleted };
}
