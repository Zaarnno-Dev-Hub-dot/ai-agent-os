/**
 * Small curated shortcode -> emoji map + reverse lookup for the picker.
 * Intentionally not exhaustive (no external emoji dataset dependency for Phase 2);
 * covers common reaction/chat use. Extend the map as needed.
 */
export const SHORTCODE_MAP: Record<string, string> = {
  smile: '\u{1F604}',
  grin: '\u{1F601}',
  joy: '\u{1F602}',
  slightly_smiling_face: '\u{1F642}',
  wink: '\u{1F609}',
  thinking: '\u{1F914}',
  fire: '\u{1F525}',
  rocket: '\u{1F680}',
  tada: '\u{1F389}',
  eyes: '\u{1F440}',
  thumbsup: '\u{1F44D}',
  '+1': '\u{1F44D}',
  thumbsdown: '\u{1F44E}',
  '-1': '\u{1F44E}',
  clap: '\u{1F44F}',
  pray: '\u{1F64F}',
  heart: '\u{2764}\u{FE0F}',
  100: '\u{1F4AF}',
  white_check_mark: '\u{2705}',
  x: '\u{274C}',
  warning: '\u{26A0}\u{FE0F}',
  rotating_light: '\u{1F6A8}',
  bug: '\u{1F41B}',
  gear: '\u{2699}\u{FE0F}',
  robot: '\u{1F916}',
  ghost: '\u{1F47B}',
  skull: '\u{1F480}',
  wave: '\u{1F44B}',
  raised_hands: '\u{1F64C}',
  brain: '\u{1F9E0}',
  bulb: '\u{1F4A1}',
  hourglass: '\u{23F3}',
  checkered_flag: '\u{1F3C1}',
  construction: '\u{1F6A7}',
  mag: '\u{1F50D}',
  memo: '\u{1F4DD}',
  scroll: '\u{1F4DC}',
  package: '\u{1F4E6}',
  link: '\u{1F517}',
  lock: '\u{1F512}',
  key: '\u{1F511}',
  question: '\u{2753}',
  exclamation: '\u{2757}',
  green_heart: '\u{1F49A}',
  yellow_heart: '\u{1F49B}',
  tiger: '\u{1F42F}',
  graduation_cap: '\u{1F393}',
  coffee: '☕',
  zap: '⚡',
};

const SHORTCODE_PATTERN = /:([a-z0-9_+-]+):/gi;

export function shortcodesToEmoji(text: string): string {
  return text.replace(SHORTCODE_PATTERN, (match, name: string) => {
    const emoji = SHORTCODE_MAP[name.toLowerCase()];
    return emoji ?? match;
  });
}

/** Emoji offered in the reaction picker, a curated common subset. */
export const PICKER_EMOJI: string[] = [
  '\u{1F44D}', '\u{1F44E}', '❤️', '\u{1F525}', '\u{1F389}', '\u{1F602}',
  '\u{1F440}', '\u{1F914}', '\u{1F680}', '✅', '❌', '\u{1F44F}',
  '\u{1F64F}', '\u{1F4AF}', '\u{1F916}', '\u{1F41B}', '⚙️', '\u{1F393}',
];
