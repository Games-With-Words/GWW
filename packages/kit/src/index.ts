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
 * The engine surface the platform drives. Command → { state, events } transitions;
 * the platform wraps events in the room envelope and persists them.
 * TState and TEvent are the game's own types — the platform treats them as opaque
 * and only requires JSON-serializability for the event log.
 */
export interface GameModule<TState = unknown, TEvent = unknown> {
  manifest: GameManifest;
  /** Create a new session. Must be deterministic given the same inputs. */
  createSession(playerIds: { id: string; displayName: string }[], seed: number): { state: TState; events: TEvent[] };
  /** Apply a named command. Throws a coded error on invalid transitions. */
  command(state: TState, name: string, payload: unknown, now: number): { state: TState; events: TEvent[] };
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
      games.set(id, module);
    },
  };
}
