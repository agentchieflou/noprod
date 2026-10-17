// Reconnection delay after `attempt` failures in a row: 1 s, doubling, up to 30 s
export const backoffMs = (attempt: number) => Math.min(30000, 1000 * 2 ** Math.min(attempt, 5));
