/**
 * L0 starter deck — hand-authored, family-table safe (CONTRIBUTING house rule 6).
 *
 * Ships with the engine so the package is self-contained and playable with zero
 * I/O and zero inference (house rule 4). The forge generates and freezes larger
 * packs on top of this shape; a frozen pack plays forever whether or not a model
 * is reachable.
 *
 * What makes a prompt work here, learned while writing these:
 *
 * 1. It must be answerable in a few words by someone with NO opinion on it. A
 *    prompt that needs a story ("describe your worst holiday") makes every real
 *    answer long and specific, and long specific answers expose the Ghost for
 *    free — the game stops being a bluff and becomes a reading-comprehension
 *    test.
 * 2. The plausible answer space must be WIDE. "What is the capital of France"
 *    has one answer; the Ghost either says it or doesn't. "What's the worst name
 *    for a boat" has a thousand, so a blind answer can genuinely belong.
 * 3. Answers must not need the prompt to be funny. The board shows answers with
 *    the question hidden from one player, and the room reads them aloud — each
 *    line has to land on its own.
 *
 * `telling` lists only DISTINCTIVE subject words. Common connective words are
 * deliberately absent: a check that rejects "food court sushi" because it
 * contains "food" trains players to distrust the validator, which is worse than
 * the leak it prevents.
 */

import type { PromptCard } from "./types.js";

export const STARTER_DECK: PromptCard[] = [
  {
    id: "gw-l0-001",
    prompt: "What's the most overrated tourist attraction?",
    essence: "overrated tourist attractions",
    aliases: ["tourist traps", "overrated landmarks", "overrated places to visit"],
    category: "Family",
    telling: ["tourist", "attraction", "landmark", "sightseeing", "tourist trap"],
    difficulty: 1,
    revealLine: "Everyone was ranking tourist traps. One of you was just naming places.",
  },
  {
    id: "gw-l0-002",
    prompt: "What's a food you pretend to like?",
    essence: "foods people pretend to like",
    aliases: ["fake favorite foods", "pretending to like a food"],
    category: "Family",
    telling: ["pretend", "pretending", "secretly hate"],
    difficulty: 1,
    revealLine: "The question was what you pretend to like. Somebody was just hungry.",
  },
  {
    id: "gw-l0-003",
    prompt: "What's the worst possible name for a boat?",
    essence: "bad boat names",
    aliases: ["terrible boat names", "naming a boat"],
    category: "Mixed Chaos",
    telling: ["boat", "ship", "yacht", "sailboat"],
    difficulty: 1,
    revealLine: "Bad boat names. One of you was naming something else entirely.",
  },
  {
    id: "gw-l0-004",
    prompt: "What's the most useless thing in your kitchen?",
    essence: "useless kitchen gadgets",
    aliases: ["kitchen junk", "useless kitchen things", "things in a kitchen drawer"],
    category: "Family",
    telling: ["kitchen", "gadget", "appliance", "utensil", "drawer"],
    difficulty: 1,
    revealLine: "Useless kitchen gadgets. Somebody was guessing from vibes alone.",
  },
  {
    id: "gw-l0-005",
    prompt: "What would you never buy secondhand?",
    essence: "things you would never buy used",
    aliases: ["never buy secondhand", "used things to avoid"],
    category: "Family",
    telling: ["secondhand", "second hand", "used", "thrift", "garage sale"],
    difficulty: 2,
    revealLine: "Things you'd never buy used. One answer came in completely blind.",
  },
  {
    id: "gw-l0-006",
    prompt: "What's the worst thing to hear from your barber mid-haircut?",
    essence: "alarming things a barber says",
    aliases: ["bad barber moments", "haircut going wrong", "things a stylist says"],
    category: "Mixed Chaos",
    telling: ["barber", "haircut", "stylist", "salon", "scissors", "clippers"],
    difficulty: 2,
    revealLine: "Mid-haircut horror. Somebody didn't know they were in a chair.",
  },
  {
    id: "gw-l0-007",
    prompt: "What animal would be the worst driver?",
    essence: "animals that would drive badly",
    aliases: ["bad animal drivers", "animals behind the wheel"],
    category: "Family",
    telling: ["animal", "driver", "driving", "steering wheel"],
    difficulty: 1,
    revealLine: "Worst animal driver. One of you was picking a favorite pet.",
  },
  {
    id: "gw-l0-008",
    prompt: "What's the least threatening thing to shout during a fight?",
    essence: "unthreatening things to shout",
    aliases: ["weak threats", "harmless battle cries", "bad threats"],
    category: "Mixed Chaos",
    telling: ["threat", "threatening", "battle cry", "intimidating"],
    difficulty: 2,
    revealLine: "Least threatening battle cry. Somebody was shouting at nothing.",
  },
  {
    id: "gw-l0-009",
    prompt: "What's the worst superpower to be stuck with?",
    essence: "useless superpowers",
    aliases: ["bad superpowers", "terrible powers", "worst superpower"],
    category: "Pop Culture",
    telling: ["superpower", "superhero", "super power", "powers"],
    difficulty: 1,
    revealLine: "Useless superpowers. One answer was a shot in the dark.",
  },
  {
    id: "gw-l0-010",
    prompt: "What should you never say during a wedding toast?",
    essence: "things not to say in a wedding toast",
    aliases: ["bad wedding toasts", "wedding disasters", "things not to say at a wedding"],
    category: "Family",
    telling: ["wedding", "toast", "bride", "groom", "marriage", "reception"],
    difficulty: 2,
    revealLine: "Wedding toast disasters. Somebody wasn't even at the wedding.",
  },
  {
    id: "gw-l0-011",
    prompt: "What's the most suspicious thing to find in someone's freezer?",
    essence: "suspicious things in a freezer",
    aliases: ["strange freezer contents", "weird things in a freezer"],
    category: "Mixed Chaos",
    telling: ["freezer", "frozen", "fridge", "refrigerator", "ice tray"],
    difficulty: 2,
    revealLine: "Suspicious freezer contents. One of you was writing blind.",
  },
  {
    id: "gw-l0-012",
    prompt: "What's a terrible theme for a kid's birthday party?",
    essence: "bad birthday party themes",
    aliases: ["terrible party themes", "bad kids party ideas"],
    category: "Family",
    telling: ["birthday", "party theme", "balloons", "party bags"],
    difficulty: 2,
    revealLine: "Terrible party themes. Somebody had no idea there was a party.",
  },
  {
    id: "gw-l0-013",
    prompt: "What's the worst souvenir to bring home for someone?",
    essence: "bad souvenirs",
    aliases: ["terrible souvenirs", "bad gifts from a trip"],
    category: "Family",
    telling: ["souvenir", "gift shop", "duty free", "brought back"],
    difficulty: 2,
    revealLine: "Bad souvenirs. One answer was a total guess.",
  },
  {
    id: "gw-l0-014",
    prompt: "What's always a bad idea after midnight?",
    essence: "bad ideas after midnight",
    aliases: ["late night mistakes", "midnight decisions", "things to avoid at night"],
    category: "Mixed Chaos",
    telling: ["midnight", "late night", "3am", "after hours"],
    difficulty: 3,
    revealLine: "Bad ideas after midnight. Somebody was flying blind.",
  },
  {
    id: "gw-l0-015",
    prompt: "What job would you be fired from on day one?",
    essence: "jobs you would be fired from immediately",
    aliases: ["jobs you cannot do", "getting fired on day one", "worst job for you"],
    category: "Work",
    telling: ["fired", "hired", "day one", "job interview", "probation"],
    difficulty: 2,
    revealLine: "Fired on day one. One of you never saw the job description.",
  },
  {
    id: "gw-l0-016",
    prompt: "What's the worst thing to find in a hotel room?",
    essence: "bad things to find in a hotel room",
    aliases: ["hotel room horrors", "things in a hotel room", "bad hotel discoveries"],
    category: "Mixed Chaos",
    telling: ["hotel", "motel", "check in", "housekeeping", "minibar"],
    difficulty: 3,
    revealLine: "Hotel room horrors. Somebody wasn't sure they'd checked in.",
  },
];
