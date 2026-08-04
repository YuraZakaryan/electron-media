/** @public Search parameters for a remote subtitle provider such as OpenSubtitles. */
export interface SubtitleSearchParams {
  /** Precise match key; when available, providers should prefer it over `query`. */
  readonly tmdbId?: number;
  /** Fallback title-text search, used when `tmdbId` is unavailable. */
  readonly query?: string;
  readonly year?: string | number;
  readonly seasonNumber?: number;
  readonly episodeNumber?: number;
  /** Restricts results to one language; omit to search across all languages. */
  readonly languageCode?: string;
}

/** @public One candidate subtitle file returned by a search. */
export interface SubtitleSearchResultItem {
  readonly fileId: number;
  readonly language?: string;
  readonly release?: string;
  readonly downloadCount?: number;
  readonly rating?: number;
}

/** @public */
export interface SubtitleSearchResult {
  readonly success: boolean;
  readonly results?: readonly SubtitleSearchResultItem[];
  readonly error?: string;
}

/** @public */
export interface SubtitleDownloadResult {
  readonly success: boolean;
  /** Raw subtitle file content (SRT or VTT); the source is responsible for parsing/converting it. */
  readonly content?: string;
  readonly error?: string;
}

/**
 * Remote subtitle search/download gateway (e.g. OpenSubtitles). The host
 * application implements this over its own backend/IPC layer — the library
 * never makes network requests to a subtitle provider directly.
 * @public
 */
export interface ISubtitleGateway {
  readonly isAvailable: boolean;
  search(params: SubtitleSearchParams): Promise<SubtitleSearchResult>;
  download(fileId: number): Promise<SubtitleDownloadResult>;
}
