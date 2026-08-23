const BRACKETED_SEGMENT = /[[(][^\])]*[\])]/g;
const MUSIC_NOTE_SEGMENT = /♪[^♪]*♪?/g;

/**
 * Strips non-dialogue content (SDH sound-effect descriptions in brackets,
 * music-note-delimited lyric markers) from a subtitle cue's text, returning
 * the remaining speakable dialogue.
 *
 * Returns `null` when nothing speakable remains — signaling the caller to
 * skip synthesis for this cue entirely rather than requesting narration for
 * an empty or purely descriptive line.
 *
 * @public
 */
export function getSpeakableText(cueText: string): string | null {
  const withoutMusic = cueText.replace(MUSIC_NOTE_SEGMENT, " ");
  const withoutBrackets = withoutMusic.replace(BRACKETED_SEGMENT, " ");
  const collapsed = withoutBrackets.replace(/\s+/g, " ").trim();
  return collapsed.length > 0 ? collapsed : null;
}
