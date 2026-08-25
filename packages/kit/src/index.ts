/**
 * @gww/kit — the Games With Words platform contract.
 *
 * FOUNDING DECISION (2026-08-23, Mark): Games With Words is an arcade — a community
 * of games, each made by a person. The Oracle made the first one (Say Less).
 * Every game ships as a module implementing this contract, and the main lobby is
 * a marketplace of game tiles. Creator credit is a first-class field: the arcade
 * IS the credits screen.
 *
 * A game module is pure and deterministic. The platform (lobby service, realtime
 * gateway, NEDB event log, voice service) owns I/O, clocks and persistence; the
 * game owns rules. Spec §09: "the game engine does not contain provider-specific code."
 *
 * CONTRACT v2 (2026-08-24, Mark's call: "make the engine capable of being
 * multi-game"). v1 had exactly the three members a game needs to COMPUTE a
 * session — manifest, createSession, command — which was enough to WRITE a
 * second game but not to RUN one. Everything the platform needed in order to
 * DRIVE a game still lived in the server as say-less-shaped code: which fields
 * to redact, who receives the secret, which clock to arm, and which command a
 * firing clock should send. The server knew one game intimately and no others.
 *
 * v2 adds four surfaces that move those four decisions into the game, where the
 * knowledge already is. The server keeps one copy of the dangerous logic — a
 * single redaction choke point, a single timer — and stops knowing any game's
 * vocabulary. The symmetry is deliberate: the engine holds no platform-specific
 * code, and the platform now holds no game-specific code.
 */

/** Who made this game. Shown on the arcade tile. */
export interface GameCredit {
  /** Display name of the maker, e.g. "The Oracle", "Interchained", "Vex". */
  maker: string;
  /** Longer credit line, e.g. "Conceived by Interchained & The Oracle". */
  line?: string;
}

export interface GameManifest {
  /** Stable id, e.g. "say-less". Lowercase, url-safe. */
  gameId: string;
  title: string;
  tagline: string;
  /** Rules contract version, e.g. "say-less/1". Frozen packs bind to this (spec §07). */
  rulesVersion: string;
  credit: GameCredit;
  minPlayers: number;
  maxPlayers: number;
  /** Typical session length in minutes, for the arcade tile. */
  sessionMinutes: [number, number];
  /** Category presets this game offers (spec §04 session shape). */
  categories: string[];
}

/**
 * Who is asking to see the state.
 *
 * `viewerId` absent means nobody in particular is watching — the display board,
 * or a log line. A game that keeps secrets should treat an absent viewer as the
 * most restrictive case, never the most permissive: the board is a TV in a room
 * full of people, and is the easiest way to leak a secret to everyone at once.
 */
export interface ViewContext {
  viewerId?: string;
  /** True when the requester is the display board (desktop/TV). */
  isBoard?: boolean;
}

/**
 * A clock the platform should arm, and what to do when it expires.
 *
 * `onExpire` is the whole point of this type. The old runner switched on
 * say-less phase names to decide whether a dead clock meant "open the ballot"
 * or "end the round" — exactly the kind of knowledge that cannot survive a
 * second game. Now the game names its own expiry command and the platform just
 * calls it.
 */
export interface TimerSpec {
  ms: number;
  /** Command name to dispatch when the clock runs out, e.g. "answers.close". */
  onExpire: string;
  payload?: unknown;
}

/** What a transition means to the platform: clocks and host voice. */
export interface Effects {
  /** Arm this clock. */
  timer?: TimerSpec;
  /** Cancel any running clock (round over, game over). */
  clearTimer?: boolean;
  /**
   * Host cue name for the voice service, e.g. "round" or "correct". Unknown cue
   * names are ignored rather than raising — a game may name a moment the voice
   * bank has no lines for yet, and a missing line must never break play
   * (inference and voice stay off the critical path).
   */
  cue?: string;
}

/**
 * The engine surface the platform drives.
 *
 * TState and TEvent are the game's own types — the platform treats them as
 * opaque and only requires JSON-serializability for the event log.
 */
export interface GameModule<TState = unknown, TEvent = unknown> {
  manifest: GameManifest;

  /** Create a new session. Must be deterministic given the same inputs. */
  createSession(playerIds: { id: string; displayName: string }[], seed: number): { state: TState; events: TEvent[] };

  /**
   * Apply a named command. Throws a coded error on invalid transitions.
   *
   * IDENTITY CONVENTION (house rule 2, server-authoritative): the platform sets
   * `actorId` on every payload it dispatches, taken from the authenticated
   * socket, and a game MUST prefer it over any id the client put in the body.
   * Server timer expiries arrive with `actorId: "game"`.
   *
   * A game may still accept an explicit id field for direct engine use in tests
   * and replays — but when `actorId` is present it wins, or one phone could act
   * as another player just by lying in a payload.
   */
  command(state: TState, name: string, payload: unknown, now: number): { state: TState; events: TEvent[] };

  /**
   * Commands only the room's host may send, e.g. ["round.start", "round.end"].
   *
   * Host authority is a platform concept (the server assigns the host at game
   * start and knows which socket holds it) but WHICH commands it gates is a
   * rules question, so the game names them and the platform enforces them.
   */
  hostOnlyCommands?: string[];

  /**
   * What this viewer is allowed to see. REQUIRED — and required on purpose.
   *
   * The tempting design was to make this optional and default to "broadcast the
   * whole state", so a trivial game could skip it. But then the failure mode of
   * forgetting one method is a leaked secret on every device in the room, and
   * spec §16 calls a leaked secret a release blocker. A default that fails open
   * is not a convenience, it is a trap. Games with nothing to hide write
   * `project: projectAll` — explicit, visible in review, one line long.
   */
  project(state: TState, ctx: ViewContext): unknown;

  /**
   * Everything that must reach exactly one player and nobody else, keyed by
   * player id. Recomputed after every transition; the platform delivers only
   * what CHANGED, and re-delivers on reconnect.
   *
   * This is the surface that lets one runner drive both existing games. Say Less
   * returns a single entry — the Speaker's card. Ghostwriter returns an entry for
   * every player EXCEPT the Ghost, because there the prompt is the thing one
   * person must not see. Neither shape is special to the platform.
   *
   * Because delivery is diff-based, a game never has to think about WHEN to
   * send: it describes who should currently know what, and reconnects, extra
   * tabs and re-deliveries all fall out of that for free.
   */
  privateViews?(state: TState): Record<string, unknown>;

  /** Clocks and cues for a transition. Called once per emitted event. */
  effects?(state: TState, event: TEvent): Effects | undefined;

  /**
   * Last chance to strip an event before it goes on the wire. Return undefined
   * to drop it from the wire entirely (it is still persisted to the log).
   *
   * Redacting state is not sufficient on its own. Say Less learned this the hard
   * way: `guess.submitted` announced authorship out loud while the anonymous
   * ballot was busy hiding it.
   */
  redactEvent?(event: TEvent): unknown | undefined;

  /** Optional one-line log narration. `nameOf` resolves a player id to a name. */
  narrate?(event: TEvent, nameOf: (playerId: string | undefined) => string): string | undefined;
}

/**
 * Projection for a game with nothing to hide: everyone sees everything.
 *
 * Use as `project: projectAll` — and only when the state genuinely holds no
 * secret, no unrevealed authorship and no unplayed content. If any player must
 * ever be kept from part of the state, write a real projection instead.
 */
export function projectAll<TState>(state: TState): unknown {
  return state;
}

/** The arcade: an ordered registry of installed games. */
export interface Arcade {
  list(): GameManifest[];
  get(gameId: string): GameModule | undefined;
  register(module: GameModule): void;
}

export function createArcade(): Arcade {
  const games = new Map<string, GameModule>();
  return {
    list: () => [...games.values()].map((g) => g.manifest),
    get: (id) => games.get(id),
    register: (module) => {
      const id = module.manifest.gameId;
      if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
        throw new Error(`Invalid gameId "${id}": must be lowercase and url-safe.`);
      }
      if (games.has(id)) {
        throw new Error(`Game "${id}" is already registered.`);
      }
      // Refuse at the door rather than at 9pm in someone's living room.
      if (typeof module.project !== "function") {
        throw new Error(
          `Game "${id}" has no project() — the platform will not broadcast a state it cannot redact. ` +
            `Use projectAll from @gww/kit if the game truly has nothing to hide.`,
        );
      }
      games.set(id, module);
    },
  };
}

export * from "./testing.js";
