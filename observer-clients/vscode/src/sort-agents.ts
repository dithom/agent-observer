interface SortableAgent {
  status: string;
  timestamp: number;
}

export function sortAgents<T extends SortableAgent>(list: T[], moveInactiveToTop: boolean): T[] {
  if (!moveInactiveToTop) return list;
  return [...list].sort((a, b) => {
    const aInactive = a.status !== "running" ? 0 : 1;
    const bInactive = b.status !== "running" ? 0 : 1;
    if (aInactive !== bInactive) return aInactive - bInactive;
    return a.timestamp - b.timestamp;
  });
}
