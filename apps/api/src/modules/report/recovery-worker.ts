/** One bounded recovery pass at a time; shutdown drains before the DB closes. */
export function startReportRecovery(
  recover: () => Promise<void>,
  onError: () => void,
  intervalMs = 5_000,
): () => Promise<void> {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let active: Promise<void>;
  const pass = async () => {
    try { await recover(); } catch { onError(); }
    if (!stopped) {
      timer = setTimeout(() => { active = pass(); }, intervalMs);
      timer.unref();
    }
  };
  active = pass();
  return async () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    await active;
  };
}
