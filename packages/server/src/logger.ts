/**
 * Verbose, colored, timestamped operator log (Mark, 2026-08-23: "the cli
 * needs to be way more verbose"). The terminal is the ops dashboard — every
 * room, join, socket, command, game beat and voice attempt gets a line.
 *
 * ONE HARD RULE: a round's secret NEVER hits the log before its reveal.
 * Ops logs get pasted into chats; treat stdout as a shared display (spec §11).
 */

const useColor = process.stdout.isTTY === true && process.env["NO_COLOR"] === undefined;

const RESET = "\x1b[0m";
const COLORS: Record<string, string> = {
  http: "\x1b[36m",   // cyan
  ws: "\x1b[34m",     // blue
  room: "\x1b[33m",   // yellow
  game: "\x1b[35m",   // magenta
  voice: "\x1b[32m",  // green
  error: "\x1b[31m",  // red
  boot: "\x1b[37m",   // white
};

function stamp(): string {
  const d = new Date();
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

export function glog(tag: keyof typeof COLORS | string, msg: string): void {
  const color = useColor ? (COLORS[tag] ?? "") : "";
  const reset = useColor ? RESET : "";
  console.log(`${stamp()} ${color}[${tag}]${reset} ${msg}`);
}

/** Colorize an HTTP status like the nedb-studio logger: 2xx green, 4xx yellow, 5xx red. */
export function statusColor(status: number): string {
  if (!useColor) return String(status);
  const c = status >= 500 ? "\x1b[31m" : status >= 400 ? "\x1b[33m" : "\x1b[32m";
  return `${c}${status}${RESET}`;
}
