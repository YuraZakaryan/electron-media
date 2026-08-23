import type {
  VoiceOverLineRequest,
  VoiceOverLineResult,
  VoiceOverVoiceDescriptor,
} from "../types/voice-over.js";

/**
 * TTS synthesis gateway the host application implements over its own
 * engine (e.g. an on-device model reached via Electron IPC) — the library
 * never performs speech synthesis itself.
 *
 * Contract: {@link generateLine} and {@link listVoices} must never throw or
 * reject unexpectedly; report failure via the returned/resolved value (an
 * abort in response to the optional `signal` is the one caller-triggered
 * exception to this — see below). {@link cancelLine} is **best-effort
 * only** — a real engine may keep synthesizing after this resolves.
 * Callers (namely {@link VoiceOverController}) must not rely on
 * cancellation actually stopping generation; they guard against a stale
 * result independently regardless of whether a gateway honors cancellation
 * at all.
 *
 * @public
 */
export interface IVoiceOverGateway {
  readonly isAvailable: boolean;

  /** Returns the languages/voices this gateway can synthesize. */
  listVoices(): Promise<readonly VoiceOverVoiceDescriptor[]>;

  /**
   * Synthesizes one line of narration. Never throws; failure is
   * `{ success: false }`. `signal`, when provided, is aborted by the
   * caller for the same reasons {@link cancelLine} would be requested
   * (superseded, disabled, disposed) — a gateway with a real cancellation
   * hook (e.g. backed by `fetch`) may honor it and reject with an
   * `AbortError`, which the caller treats identically to any other
   * rejection. A gateway that ignores `signal` entirely behaves exactly as
   * if it were never passed.
   */
  generateLine(request: VoiceOverLineRequest, signal?: AbortSignal): Promise<VoiceOverLineResult>;

  /**
   * Requests that an in-flight or queued {@link generateLine} call for the
   * same `languageCode`/`text` be abandoned. Best-effort: the underlying
   * engine may still complete the synthesis; callers must not assume the
   * corresponding {@link generateLine} promise will never resolve.
   */
  cancelLine(request: { readonly languageCode: string; readonly text: string }): Promise<void>;
}
