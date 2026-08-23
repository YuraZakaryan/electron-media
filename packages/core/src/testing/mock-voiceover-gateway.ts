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

  async generateLine(request: VoiceOverLineRequest): Promise<VoiceOverLineResult> {
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
