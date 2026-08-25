import type { IVoiceOverGateway } from "../voice-over/voice-over-gateway.js";
import type {
  VoiceOverLineRequest,
  VoiceOverLineResult,
  VoiceOverVoiceDescriptor,
} from "../types/voice-over.js";

/** Test double for {@link IVoiceOverGateway}. Not exported from the package's public API. */
export class MockVoiceOverGateway implements IVoiceOverGateway {
  isAvailable = true;
  voices: readonly VoiceOverVoiceDescriptor[] = [];
  lineResultByKey = new Map<string, VoiceOverLineResult>();
  generateLineCalls: VoiceOverLineRequest[] = [];
  cancelLineCalls: Array<{ languageCode: string; text: string }> = [];

  async listVoices(): Promise<readonly VoiceOverVoiceDescriptor[]> {
    return this.voices;
  }

  // `signal` is accepted and ignored, matching IVoiceOverGateway's optional
  // second parameter. Declaring it matters even though this body never reads
  // it: tests that assert on cancellation replace this whole method with a
  // two-parameter function, which a one-parameter declaration would reject.
  async generateLine(
    request: VoiceOverLineRequest,
    _signal?: AbortSignal
  ): Promise<VoiceOverLineResult> {
    this.generateLineCalls.push(request);
    return (
      this.lineResultByKey.get(lineKey(request.languageCode, request.text)) ?? {
        success: false,
        error: "no mock result configured",
      }
    );
  }

  async cancelLine(request: { languageCode: string; text: string }): Promise<void> {
    this.cancelLineCalls.push(request);
  }
}

function lineKey(languageCode: string, text: string): string {
  return `${languageCode}:${text}`;
}
