import type {
  ISubtitleGateway,
  SubtitleDownloadResult,
  SubtitleSearchParams,
  SubtitleSearchResult,
} from "../contracts/subtitle-gateway.js";

/** Test double for {@link ISubtitleGateway}. Not exported from the package's public API. */
export class MockSubtitleGateway implements ISubtitleGateway {
  isAvailable = true;
  searchResult: SubtitleSearchResult = { success: true, results: [] };
  downloadResultByFileId = new Map<number, SubtitleDownloadResult>();
  searchCalls: SubtitleSearchParams[] = [];
  downloadCalls: number[] = [];

  async search(params: SubtitleSearchParams): Promise<SubtitleSearchResult> {
    this.searchCalls.push(params);
    return this.searchResult;
  }

  async download(fileId: number): Promise<SubtitleDownloadResult> {
    this.downloadCalls.push(fileId);
    return (
      this.downloadResultByFileId.get(fileId) ?? {
        success: false,
        error: "no mock result configured",
      }
    );
  }
}
