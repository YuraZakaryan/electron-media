/**
 * Persists the user's chosen audio-track language across sessions, for
 * {@link AudioTrackController}'s auto-restore. The host application
 * implements this over its own storage mechanism (e.g. localStorage,
 * electron-store) — the library never touches persistence directly, and
 * treats a missing store as "no persistence" rather than throwing.
 *
 * Deliberately audio-only: subtitle preference restore is not this simple
 * — "off" needs to be distinguishable from "no preference yet", and a
 * remembered choice is source-aware (an embedded track and an OpenSubtitles
 * result in the same language are not the same pick). A host application
 * with multiple subtitle sources should implement that matching itself
 * against {@link SubtitleController.getTracks}, the way this library's own
 * reference integration does.
 * @public
 */
export interface PlayerPreferenceStore {
  getAudioLanguage(): string | null;
  setAudioLanguage(language: string): void;
}
