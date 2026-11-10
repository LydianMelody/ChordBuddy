// How often the page asks the app "anything new?". Asking is cheap but not free (the app rebuilds its state from the library each time),
// so the pace follows what is going on: quick while a job runs (its progress bar should move), the old steady pace for a short while
// after anything changed or the user did something (more changes tend to follow), and slow once the app has sat unchanged for a while.
export const POLL_BUSY_MS=1000,POLL_SETTLING_MS=2500,POLL_IDLE_MS=10000;
export const SETTLE_FOR_MS=30000;     // how long after the last change the steady pace is kept before slowing down
// While the state is unchanged the page skips its other checks; this often it still looks at the open song's files, so a recording or
// stems that went missing on disk are noticed without anything else having to change first.
export const RECHECK_MS=30000;

/** The wait before the next poll. `sinceChange` is the time (ms) since the state last changed or the user last acted. */
export function pollDelay({jobActive=false,sinceChange=Infinity}={}){
  if(jobActive)return POLL_BUSY_MS;
  return sinceChange>=0&&sinceChange<SETTLE_FOR_MS?POLL_SETTLING_MS:POLL_IDLE_MS;
}
