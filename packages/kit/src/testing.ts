/**
 * The conformance harness — house rules enforced by a function instead of by a
 * code review.
 *
 * CONTRIBUTING lists six house rules for a game (deterministic, server-
 * authoritative, secrets private, inference off the path, tested, kind). Four of
 * those are mechanically checkable, and every one of them is a rule where the
 * failure is quiet: a `Math.random()` in a rules engine doesn't crash, it just
 * makes the event log a lie; a secret in a public projection doesn't crash, it
 * just ends the round early on somebody's TV; a typo in a timer's expiry command
 * doesn't crash, it hangs a living room at 9pm and nobody knows why.
 *
 * So the harness exists to make a maker's FIRST game hit those walls on their own
 * machine, in the second before they open a PR. Deliberately framework-free — no
 * vitest import — so it can be called from any test runner, or from a script, or
 * from CI directly.
 */

import type { GameModule, TimerSpec } from "./index.js";

export interface ConformancePlayer {
  id: string;
  displayName: string;
}

export interface ScriptedCommand {
  name: string;
  payload?: unknown;
  /** Server time. Defaults to a monotonic step counter if omitted. */
  now?: number;
}

export interface ConformanceOptions {
  players: ConformancePlayer[];
  seed?: number;
  /**
   * Drive the session. Return the next command to apply, or undefined to stop.
   *
   * Takes the live state so a script can answer "whoever the ghost is" or
   * "whichever slot belongs to p2" without the harness knowing the game.
   */
  next(state: unknown, step: number): ScriptedCommand | undefined;
  /**
   * Strings that must never appear in a public projection or a wire event at
   * this moment — the secret, the prompt, the unrevealed authorship.
   *
   * A function of state rather than a constant, because what is secret CHANGES:
   * a secret before the reveal is public content after it, and asserting the
   * former forever would make the harness fail correct games.
   */
  secrets?(state: unknown): string[];
  /** Safety valve for a script that never returns undefined. */
  maxSteps?: number;
}

export interface ConformanceResult {
  ok: boolean;
  failures: string[];
  /** Steps actually executed, for a sanity check on the script itself. */
  steps: number;
}

function json(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch (err) {
    return `__UNSERIALIZABLE__:${String(err)}`;
  }
}

/** Manifest sanity — the cheap checks that stop a broken tile shipping. */
function checkManifest(module: GameModule, fail: (s: string) => void): void {
  const m = module.manifest;
  if (!/^[a-z0-9][a-z0-9-]*$/.test(m.gameId)) fail(`manifest.gameId "${m.gameId}" is not lowercase url-safe.`);
  if (m.title.trim() === "") fail("manifest.title is empty.");
  if (m.tagline.trim() === "") fail("manifest.tagline is empty — the tile has nothing to sell.");
  if (!m.rulesVersion.startsWith(`${m.gameId}/`)) {
    fail(`manifest.rulesVersion "${m.rulesVersion}" should start with "${m.gameId}/" so frozen packs bind to it.`);
  }
  if (m.credit.maker.trim() === "") fail("manifest.credit.maker is empty — the arcade IS the credits screen.");
  if (m.minPlayers < 2) fail("manifest.minPlayers must be at least 2.");
  if (m.maxPlayers < m.minPlayers) fail("manifest.maxPlayers is below minPlayers.");
  if (m.sessionMinutes[0] <= 0 || m.sessionMinutes[1] < m.sessionMinutes[0]) {
    fail(`manifest.sessionMinutes ${json(m.sessionMinutes)} is not an ascending positive range.`);
  }
  if (m.categories.length === 0) fail("manifest.categories is empty.");
  if (typeof module.project !== "function") fail("project() is required — see @gww/kit projectAll.");
}

/**
 * Play the scripted session once, collecting everything the platform would do.
 * Returned so the caller can compare two runs for determinism.
 */
function playOnce(
  module: GameModule,
  opts: ConformanceOptions,
  fail: (s: string) => void,
): { finalState: unknown; wire: string[]; steps: number } {
  const seed = opts.seed ?? 1234;
  const maxSteps = opts.maxSteps ?? 200;
  const created = module.createSession(opts.players, seed);
  let state: unknown = created.state;
  const wire: string[] = [];
  const playerIds = new Set(opts.players.map((p) => p.id));

  const inspect = (events: unknown[], step: number): void => {
    const secrets = opts.secrets?.(state) ?? [];

    // Public projections: the board (no viewer) and every player in turn.
    const views: { label: string; value: unknown }[] = [
      { label: "board", value: module.project(state, { isBoard: true }) },
      { label: "anonymous", value: module.project(state, {}) },
      ...opts.players.map((p) => ({ label: `viewer ${p.id}`, value: module.project(state, { viewerId: p.id }) })),
    ];
    for (const v of views) {
      const text = json(v.value);
      if (text.startsWith("__UNSERIALIZABLE__")) {
        fail(`step ${step}: project() for ${v.label} is not JSON-serializable — the event log needs it to be.`);
      }
      for (const s of secrets) {
        if (s !== "" && text.includes(s)) {
          fail(`step ${step}: project() for ${v.label} leaks a private value ("${s}").`);
        }
      }
    }

    for (const e of events) {
      const redacted = module.redactEvent?.(e) ?? e;
      if (redacted === undefined) continue;
      const text = json(redacted);
      wire.push(text);
      for (const s of secrets) {
        if (s !== "" && text.includes(s)) {
          fail(`step ${step}: event on the wire leaks a private value ("${s}"): ${text}`);
        }
      }
    }

    // Private views must address real players, and must be serializable.
    const priv = module.privateViews?.(state) ?? {};
    for (const [pid, value] of Object.entries(priv)) {
      if (!playerIds.has(pid)) fail(`step ${step}: privateViews names "${pid}", who is not in the session.`);
      if (json(value).startsWith("__UNSERIALIZABLE__")) {
        fail(`step ${step}: privateViews["${pid}"] is not JSON-serializable.`);
      }
    }

    /**
     * Every timer the game asks for must be answerable.
     *
     * A wrong `onExpire` name is the worst bug class this contract can produce:
     * nothing throws at arm time, the clock fires into a command the engine
     * doesn't have, and the round simply stops. Checking it here costs one
     * discarded call and turns a silent hang into a failing test.
     */
    for (const e of events) {
      const timer: TimerSpec | undefined = module.effects?.(state, e)?.timer;
      if (timer === undefined) continue;
      if (timer.ms <= 0) fail(`step ${step}: timer for ${json(e)} has non-positive ms (${timer.ms}).`);
      try {
        module.command(state, timer.onExpire, timer.payload, 10 ** 9);
      } catch (err) {
        const code = (err as { code?: string }).code ?? "";
        if (code === "UNKNOWN_COMMAND") {
          fail(`step ${step}: timer onExpire "${timer.onExpire}" is not a command this game accepts — a live room would hang.`);
        }
        // Any other coded error is legitimate: the phase may have moved on
        // between arming and firing, which the real runner tolerates too.
      }
    }
  };

  inspect(created.events, 0);

  let step = 0;
  for (; step < maxSteps; step++) {
    const cmd = opts.next(state, step);
    if (cmd === undefined) break;
    const t = module.command(state, cmd.name, cmd.payload ?? {}, cmd.now ?? 1000 + step);
    state = t.state;
    inspect(t.events, step + 1);
  }
  if (step >= maxSteps) fail(`script never finished within maxSteps (${maxSteps}).`);

  return { finalState: state, wire, steps: step };
}

/**
 * Run the conformance suite against a game module.
 *
 * Returns failures rather than throwing so a caller can assert on the whole list
 * at once — one run showing five problems beats five runs showing one.
 */
export function checkConformance(module: GameModule, opts: ConformanceOptions): ConformanceResult {
  const failures: string[] = [];
  const fail = (s: string): void => { failures.push(s); };

  checkManifest(module, fail);

  const first = playOnce(module, opts, fail);
  const second = playOnce(module, opts, fail);

  if (json(first.finalState) !== json(second.finalState)) {
    fail(
      "not deterministic: the same seed and the same commands produced two different final states. " +
        "A Math.random() or a Date.now() in the engine is the usual cause.",
    );
  }
  if (json(first.wire) !== json(second.wire)) {
    fail("not deterministic: the same seed and commands produced two different event streams.");
  }
  if (first.steps === 0) {
    fail("the script applied no commands — a conformance run that plays nothing proves nothing.");
  }

  return { ok: failures.length === 0, failures, steps: first.steps };
}

/**
 * Convenience for a test runner: throws with every failure listed, or returns.
 *
 * `expect(() => assertConformance(mod, opts)).not.toThrow()` reads worse than a
 * bare call, so this is written to be called directly in a test body.
 */
export function assertConformance(module: GameModule, opts: ConformanceOptions): void {
  const result = checkConformance(module, opts);
  if (!result.ok) {
    throw new Error(
      `${module.manifest.gameId} failed ${result.failures.length} conformance check(s):\n  - ` +
        result.failures.join("\n  - "),
    );
  }
}
