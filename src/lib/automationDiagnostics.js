// Diagnostic reads must not hold every control hostage to one slow dependency.
export async function withDiagnosticDeadline(task, timeoutMs = 12000) {
  let timer
  try {
    return await Promise.race([
      Promise.resolve().then(task),
      new Promise((_, reject) => { timer = setTimeout(() => reject(Error('DIAGNOSTIC_TIMEOUT')), timeoutMs) }),
    ])
  } finally { clearTimeout(timer) }
}
export function settleAutomationChecks(promises, timeoutMs = 12000) {
  return Promise.allSettled(promises.map(promise => withDiagnosticDeadline(() => promise, timeoutMs)))
}
