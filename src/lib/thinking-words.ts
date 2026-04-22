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

export const WORKING_WORDS = [
  "Working",
  "Warming up",
  "Spinning up",
  "Starting",
  "Reaching out",
  "Connecting",
  "Processing",
  "Loading",
  "Preparing",
];

export function pickFrom(list: string[], prev?: string): string {
  if (list.length === 0) return "";
  if (list.length < 2) return list[0];
  while (true) {
    const w = list[Math.floor(Math.random() * list.length)];
    if (w !== prev) return w;
  }
}

export function pickThinkingWord(prev?: string): string {
  return pickFrom(THINKING_WORDS, prev);
}
