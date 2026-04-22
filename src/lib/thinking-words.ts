export const THINKING_WORDS = [
  "Thinking",
  "Pondering",
  "Musing",
  "Considering",
  "Deliberating",
  "Ruminating",
  "Contemplating",
  "Reflecting",
  "Cogitating",
  "Reasoning",
  "Analyzing",
  "Brewing",
  "Churning",
  "Thundering",
  "Simmering",
  "Crunching",
  "Scheming",
  "Weaving",
  "Stirring",
  "Unraveling",
  "Decoding",
  "Plotting",
];

export function pickThinkingWord(prev?: string): string {
  if (THINKING_WORDS.length < 2) return THINKING_WORDS[0];
  while (true) {
    const w = THINKING_WORDS[Math.floor(Math.random() * THINKING_WORDS.length)];
    if (w !== prev) return w;
  }
}
