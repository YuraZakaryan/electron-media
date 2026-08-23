import type {
  IVoiceOverGateway,
  VoiceOverLineRequest,
  VoiceOverLineResult,
  VoiceOverVoiceDescriptor,
} from "@electron-media/core";

/**
 * Local test double for {@link IVoiceOverGateway} — mirrors core's own
 * (package-internal, unexported) MockVoiceOverGateway, since this package
 * can only depend on core's public API surface.
 */
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
      this.lineResultByKey.get(`${request.languageCode}:${request.text}`) ?? {
        success: false,
        error: "no mock result configured",
      }
    );
  }

  async cancelLine(request: { languageCode: string; text: string }): Promise<void> {
    this.cancelLineCalls.push(request);
  }
}
