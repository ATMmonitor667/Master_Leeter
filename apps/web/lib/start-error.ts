/** Closed copy avoids showing internal codes or provider text during setup. */
export function startError(code: unknown, fallback = "The interview could not start. Please retry."): string {
  switch (code) {
    case "ACTIVE_SESSION_EXISTS": return "You already have an active interview. Open History to resume it before starting another.";
    case "MONTHLY_QUOTA_REACHED": return "You have used your free interview allowance for this month. It renews at the start of the next UTC month.";
    case "GLOBAL_CAPACITY_REACHED": return "All interview spaces are currently in use. Please try again shortly.";
    case "ADMISSION_PAUSED":
    case "SERVICE_DRAINING": return "New interviews are temporarily paused. Please try again later; existing interviews remain in History.";
    case "RATE_LIMITED": return "There have been too many requests. Wait a minute before trying again.";
    case "ADMISSION_UNAVAILABLE":
    case "QUESTION_BANK_UNAVAILABLE":
    case "NO_ACTIVE_QUESTIONS": return "The interview service is temporarily unavailable. Please try again shortly.";
    case "PREPARATION_BUSY": return "Your interview preparation is still running. Please retry shortly.";
    case "PREPARATION_ALREADY_PINNED": return "Your preparation already has a question. Choose the original interview to continue.";
    default: return fallback;
  }
}
