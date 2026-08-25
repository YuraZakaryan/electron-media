/**
 * Persists the user's chosen audio-track (and, optionally, voice-over)
 * language across sessions. The host application implements this over its
 * own storage mechanism (e.g. localStorage, electron-store) — the library
 * never touches persistence directly, and treats a missing store, or a
 * missing optional method, as "no persistence" rather than throwing.
 *
 * `getAudioLanguage`/`setAudioLanguage` are required — every implementer
 * already provides them for {@link AudioTrackController}'s auto-restore.
 * `getVoiceOverLanguage`/`setVoiceOverLanguage` are **optional**, so adding
 * them here never breaks an existing implementer that only ever needed the
 * audio pair.
 *
 * Voice-over's restore is safe in the same way audio's is — exactly one
 * language dimension, one gateway, no source-awareness problem — unlike
 * subtitle preference restore, which stays deliberately out of scope: "off"
 * needs to be distinguishable from "no preference yet", and a remembered
 * choice there is source-aware (an embedded track and an OpenSubtitles
 * result in the same language are not the same pick). A host application
 * with multiple subtitle sources should implement that matching itself
 * against {@link SubtitleController.getTracks}, the way this library's own
 * reference integration does. Voice-over's own default, unlike audio's, is
 * OFF — no stored preference means narration stays disabled, not "pick
 * something anyway". Unlike audio (which can never be turned off, so its
 * `setAudioLanguage` never needs to express "no preference"),
 * `setVoiceOverLanguage` accepts `null` for exactly that: an explicit
 * {@link VoiceOverController.selectTrack}`(null)` clears the stored
 * preference, so a user who deliberately turns narration off doesn't have
 * it silently turn back on from a stale stored language on the next
 * restore.
 * @public
 */
export interface PlayerPreferenceStore {
  getAudioLanguage(): string | null;
  setAudioLanguage(language: string): void;
  getVoiceOverLanguage?(): string | null;
  setVoiceOverLanguage?(language: string | null): void;
}
