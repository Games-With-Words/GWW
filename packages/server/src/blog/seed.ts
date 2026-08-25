/**
 * The hand-written floor.
 *
 * Same idea as the L0 voice lines: the automated layer is allowed to fail, and
 * when it does the surface must still be worth landing on. A blog index reading
 * "no posts yet" is a page that teaches a crawler to come back less often, and
 * these two posts also serve as the reference standard — if Muse's output is
 * noticeably worse than what is below, the gates in service.ts are too loose.
 *
 * Both are written from things that actually happened while building and playing
 * this game, which is the one thing a generated post cannot borrow.
 */

import type { BlogStore, Post } from "./store.js";

const HOST_A_GAME_NIGHT = `Most game nights don't die because the game was bad. They die in the eleven minutes between "let's play something" and the first round actually starting — the rules explanation, the app downloads, the person still choosing a username. By the time play begins, two people have quietly picked their phones back up and the room's energy is gone.

That gap is the only part of the evening you fully control. Here's how to close it.

## Pick the game before anyone arrives

Deciding as a group is the single most expensive thing you can do to an evening. Six people politely deferring to each other takes fifteen minutes and produces the most inoffensive option in the room.

Choose it yourself, in advance. Nobody has ever been annoyed at a host who said "we're playing this one, it takes two minutes to learn". If it goes badly, you switch — that costs less than the debate would have.

## Teach the rules in one sentence, then start

Every party game has a one-sentence version, and it is always enough to begin:

- **Say Less** — one person gets a secret word and has to make everyone guess it using as few words as possible.
- **Ghost Writer** — everyone answers the same question, except one player who never saw the question and has to fake it.
- Charades — act it out, no talking.

Say the sentence. Start the round. The edge cases explain themselves the first time they come up, and a rule learned in play sticks; a rule learned in a lecture does not. If you catch yourself saying "oh, and one more thing", stop talking and deal.

## Remove every step between deciding and playing

Count the steps your game needs before round one. Each one is a place the evening can stall:

- An app to install is at least three minutes and one person with no storage space left.
- An account is an email, a password, and someone locked out of their own inbox.
- A physical setup — cards dealt, boards laid out, pieces sorted — is fine, but do it before people arrive, not while they watch.

This is most of why we built Games With Words the way we did. The TV shows a code, everyone types it into their phone's browser, and that's the setup. Not because setup is the interesting part of a game, but because it's the part that decides whether you ever reach the interesting part.

## Sit people so they can see each other

Party games are conversations with a scoring system. If half the room is looking at the back of someone's head, half the room isn't playing.

Put the screen where nobody has to turn away from the group to see it. If you're using a TV, that usually means moving one chair — thirty seconds of furniture for an evening of everyone actually facing each other.

## Play short rounds and stop while it's good

The best possible ending to a game night is someone saying "one more round" and being told no.

Short rounds do two things. They give the person who had a bad turn an immediate second chance, and they let anyone leave at a clean moment without feeling like they broke something. A game that takes ninety minutes has one exit; a game made of four-minute rounds has twenty.

Stop about twenty minutes before the room gets tired. You'll be wrong about when that is — aim early. Nobody remembers the round that didn't happen, but everyone remembers the hour where it dragged.

## The one thing that matters more than the game

Laugh first, and laugh at yourself. The host sets the ceiling for how silly the room is willing to be. If you play your first turn carefully and correctly, everyone else will too, and a careful, correct party game is just admin.

Make a terrible clue on purpose. Get caught bluffing. The room will follow you.`;

const WORD_GAMES_FOR_GROUPS = `Word games have a reputation problem. Say the phrase and half the room thinks of Scrabble — a game where the person with the best vocabulary wins and everyone else waits their turn.

The word games that actually work at a party aren't about knowing words. They're about *choosing* them, under pressure, in front of people who know you. Here's what separates the ones that land from the ones that quietly end after two rounds.

## Everyone plays every round, or someone stops playing

The fastest way to lose a player is to make them wait. In a turn-based word game with eight people, you're a spectator for seven-eighths of the evening — and a spectator with a phone in their pocket becomes a person on their phone.

Look for games where a round involves everybody: everyone writes, everyone guesses, everyone votes. It also fixes the vocabulary problem sideways. When all eight answers arrive at once, the funniest answer beats the cleverest one about nine times out of ten.

## Constraint is the whole game

"Describe this word" is not a game. "Describe this word in three words, and you can't say these five" is a game.

Constraint does the work that a good opponent would otherwise have to do. It makes a choice hard, it makes failure funny instead of embarrassing, and it means the best player is the one who thinks sideways rather than the one who reads more.

This is the entire design of Say Less: you get a secret word, and fewer words scores more. Nobody has ever needed that rule explained twice, and the tension is immediate — every extra word you spend is points you're giving away.

## Someone should be allowed to lie

A word game where everyone is trying to be correct has one emotional register. Add a player with a different goal and the whole table changes: now you're reading faces, not just answers.

Ghost Writer is built on exactly that. Everyone answers the same prompt on their phone — except one person, the Ghost, who never sees the question and has to write something that fits well enough to pass. The answers get read out anonymously, and the room votes on which one was written blind.

What makes it work isn't the bluffing. It's that a good Ghost answer is genuinely funny in a way an honest answer can't be, so the room half-wants to be fooled.

## Short rounds beat long games

Four minutes is a good round. It's long enough for a real decision and short enough that a bad turn is over before you've finished being annoyed about it.

Long word games have a specific failure mode: the person who's behind knows they're behind for forty minutes. Short rounds keep resetting the scoreboard's emotional weight, and they let people join late or drop out without wrecking the game.

## The scoring should reward the room, not the dictionary

Here's the test. Ask yourself: could the funniest person at the table win, even if they're the worst speller?

If the answer is no, you've got a vocabulary test with a party theme. The scoring in a good group word game pays for things the room decides — the answer that made everyone laugh, the bluff nobody caught, the clue that was technically terrible and completely worked.

## What to try

If you want to test this on a real group, four to ten people is the sweet spot, and you want something with no setup — the first round should start within two minutes of the decision.

[Games With Words](/) is our version of this: it runs in a browser, one screen is the board, everyone else joins on their phone with a code. Both games above are on it, it's free, and there's nothing to install. But the principles hold whatever you play — everyone in every round, a constraint that hurts, someone allowed to lie, and scoring that pays for laughter.`;

/** The floor, as posts. Published dates are set at seed time, not baked in. */
export function seedPosts(now: number): Post[] {
  return [
    {
      slug: "how-to-host-a-game-night",
      title: "How to Host a Game Night That Doesn't Die",
      description: "Game nights don't fail because the game was bad — they fail in the eleven minutes before the first round. Six fixes for the part nobody plans.",
      body: HOST_A_GAME_NIGHT,
      topic: "how to host a game night that doesn't die in the first ten minutes",
      keywords: ["how to host a game night", "party game night tips", "game night ideas", "party games for groups"],
      status: "published",
      createdAt: now,
      publishedAt: now,
      source: "hand",
    },
    {
      slug: "word-games-for-groups",
      title: "What Makes a Word Game Work With a Group",
      description: "The word games that survive a party aren't about vocabulary. Five things that separate the ones people ask to replay from the ones that quietly end.",
      body: WORD_GAMES_FOR_GROUPS,
      topic: "word games for groups of 4 to 10 people",
      keywords: ["word games for groups", "party word games", "word games for adults", "group games with words"],
      status: "published",
      // Staggered by a day so the index has a real chronology rather than two
      // posts sharing a timestamp to the millisecond.
      createdAt: now - 86_400_000,
      publishedAt: now - 86_400_000,
      source: "hand",
    },
  ];
}

/**
 * Write the floor, once.
 *
 * Keyed on the slug rather than on "is the blog empty", so deleting a seed post
 * on purpose does not bring it back on the next boot — but a fresh deployment
 * gets both. An operator's delete is a decision, and boot should not overrule it.
 */
export function seedIfMissing(store: BlogStore, now: number): number {
  let written = 0;
  const anyPost = store.list({ includeDrafts: true }).length > 0;
  if (anyPost) return 0;
  for (const post of seedPosts(now)) {
    if (store.get(post.slug) !== undefined) continue;
    store.save(post);
    written += 1;
  }
  if (written > 0) console.log(`[blog] seeded ${written} hand-written post(s)`);
  return written;
}
