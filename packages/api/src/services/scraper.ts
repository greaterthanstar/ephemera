import { CheerioCrawler, type CheerioRoot } from 'crawlee';
import type { SearchQuery, Book, SearchResponse } from '@ephemera/shared';
import { getErrorMessage } from '@ephemera/shared';
import { logger } from '../utils/logger.js';
import { searchCacheManager } from './search-cache.js';

const BASE_URL = process.env.AA_BASE_URL;

/**
 * Transform an AA image URL to use our proxy endpoint
 * This protects client IP addresses from being exposed to AA
 *
 * TEMPORARILY DISABLED: The proxy creates connection blocking issues.
 * Browser has 6 connection limit to localhost:8286. Even with lazy loading
 * and semaphore limiting, proxy requests hold connections open while waiting,
 * which blocks pagination requests. Direct loading works fine.
 *
 * TODO: Implement proper image caching to disk, then re-enable proxy
 */
function transformImageUrlToProxy(originalUrl: string | undefined): string | undefined {
  if (!originalUrl) return undefined;

  // TEMPORARILY: Return original URL for direct loading
  return originalUrl;

  // When re-enabling proxy with caching:
  // const encodedUrl = Buffer.from(originalUrl, 'utf-8').toString('base64');
  // return `/api/proxy/image?url=${encodedUrl}`;
}
export class AAScraper {
  private lastResult: SearchResponse | null = null;

  private async fetchViaFlareSolverr(url: string, crawlId: string): Promise<SearchResponse | null> {
    const flaresolverrUrl = process.env.FLARESOLVERR_URL;
    if (!flaresolverrUrl) {
      logger.debug(`[${crawlId}] FLARESOLVERR_URL not configured, skipping FlareSolverr fallback`);
      return null;
    }

    const endpoint = `${flaresolverrUrl.replace(/\/$/, '')}/v1`;
    logger.info(`[${crawlId}] Direct request returned no results/blocked. Trying FlareSolverr at ${endpoint}...`);

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cmd: 'request.get',
          url,
          maxTimeout: 60000,
        }),
      });

      if (!response.ok) {
        logger.warn(`[${crawlId}] FlareSolverr HTTP ${response.status}`);
        return null;
      }

      const json = (await response.json()) as { status?: string; solution?: { response?: string }; message?: string };
      if (json.status === 'ok' && json.solution && json.solution.response) {
        const cheerio = await import('cheerio');
        const $ = cheerio.load(json.solution.response);
        const books = AAScraper.parseBooks($ as unknown as CheerioRoot);
        const pagination = AAScraper.parsePagination($ as unknown as CheerioRoot);
        logger.info(`[${crawlId}] FlareSolverr returned ${books.length} books`);
        if (books.length > 0) {
          return { results: books, pagination };
        }
      } else {
        logger.warn(`[${crawlId}] FlareSolverr returned status: ${json.status || ''} - ${json.message || ''}`);
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      logger.warn(`[${crawlId}] FlareSolverr request failed: ${msg}`);
    }
    return null;
  }

  async scrapeUrl(url: string): Promise<SearchResponse> {
    const crawlId = Math.random().toString(36).substring(7);
    logger.info(`[${crawlId}] Crawler starting for: ${url}`);

    let crawlerResult: SearchResponse | null = null;

    const crawler = new CheerioCrawler({
      maxRequestRetries: 3,
      requestHandlerTimeoutSecs: 30,
      maxConcurrency: 1,
      useSessionPool: false,

      // Add headers to look like a regular browser
      additionalMimeTypes: ['application/json'],
      preNavigationHooks: [
        async ({ request }) => {
          logger.info(`[${crawlId}] Sending HTTP request...`);
          request.headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.5',
            'Accept-Encoding': 'gzip, deflate, br',
            'Connection': 'keep-alive',
            'Upgrade-Insecure-Requests': '1',
          };
        },
      ],

      requestHandler: async ({ $, _request, _log }) => {
        logger.info(`[${crawlId}] HTTP response received, parsing HTML...`);

        // Parse the page
        const parseStart = Date.now();
        const books = AAScraper.parseBooks($);
        const pagination = AAScraper.parsePagination($);
        const parseDuration = Date.now() - parseStart;

        logger.info(`[${crawlId}] Parsed ${books.length} books in ${parseDuration}ms`);

        // Store result for retrieval
        crawlerResult = {
          results: books,
          pagination,
        };
      },

      failedRequestHandler: async ({ request }, error) => {
        // Only log non-network errors (network errors are expected from AA)
        const isNetworkError = error.message?.includes('terminated') ||
                              error.message?.includes('socket') ||
                              error.message?.includes('ECONNREFUSED');

        if (!isNetworkError) {
          logger.error(`[${crawlId}] Request ${request.url} failed:`, error.message);
        } else {
          logger.warn(`[${crawlId}] Network error (expected): ${error.message}`);
        }

        // Don't throw - return empty result instead
        crawlerResult = {
          results: [],
          pagination: { page: 1, per_page: 50, has_next: false, has_previous: false, estimated_total_results: null },
        };
      },
    });

    try {
      // Run crawler - add unique ID to bypass Crawlee's deduplication
      // We handle caching at the database level, so Crawlee's deduplication interferes
      const uniqueUrl = `${url}${url.includes('?') ? '&' : '?'}_crawl=${Date.now()}`;
      const crawlerStart = Date.now();
      await crawler.run([uniqueUrl]);
      logger.info(`[${crawlId}] Crawler completed in ${Date.now() - crawlerStart}ms`);
    } catch (error: unknown) {
      // Only log unexpected errors (socket/network errors are expected from AA)
      const errorMessage = getErrorMessage(error);
      const errorCode = typeof error === 'object' && error !== null && 'code' in error ? (error as { code: unknown }).code : undefined;
      const isNetworkError = errorMessage.includes('terminated') ||
                            errorMessage.includes('socket') ||
                            errorMessage.includes('ECONNREFUSED') ||
                            errorCode === 'UND_ERR_SOCKET';

      if (!isNetworkError) {
        logger.warn(`[${crawlId}] Crawler error for ${url}:`, errorMessage);
      } else {
        logger.warn(`[${crawlId}] Network error (expected): ${errorMessage}`);
      }
    }

    let res = crawlerResult as SearchResponse | null;

    // If primary URL returned 0 results/blocked, try active mirror annas-archive.is
    if ((!res || res.results.length === 0) && !url.includes('annas-archive.is')) {
      const fallbackUrl = url.replace(/https:\/\/[^/]+/, 'https://annas-archive.is');
      logger.info(`[${crawlId}] Primary domain returned 0 results. Trying active mirror ${fallbackUrl}...`);
      try {
        const fallbackCrawler = new CheerioCrawler({
          maxRequestRetries: 2,
          requestHandlerTimeoutSecs: 20,
          maxConcurrency: 1,
          useSessionPool: false,
          preNavigationHooks: [
            async ({ request }) => {
              request.headers = {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
              };
            },
          ],
          requestHandler: async ({ $ }) => {
            const books = AAScraper.parseBooks($);
            const pagination = AAScraper.parsePagination($);
            if (books.length > 0) {
              crawlerResult = { results: books, pagination };
            }
          },
        });
        await fallbackCrawler.run([`${fallbackUrl}${fallbackUrl.includes('?') ? '&' : '?'}_crawl=${Date.now()}`]);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        logger.warn(`[${crawlId}] Fallback mirror fetch failed: ${msg}`);
      }
      res = crawlerResult as SearchResponse | null;
    }

    // Check if direct crawl / mirror returned results; if empty/blocked, try FlareSolverr fallback
    if (!res || res.results.length === 0) {
      const flareResult = await this.fetchViaFlareSolverr(url, crawlId);
      if (flareResult && flareResult.results.length > 0) {
        crawlerResult = flareResult;
      }
    }

    this.lastResult = crawlerResult;

    // Return result
    return crawlerResult || {
      results: [],
      pagination: { page: 1, per_page: 50, has_next: false, has_previous: false, estimated_total_results: null },
    };
  }

  private static parseBooks($: CheerioRoot): Book[] {
    const books: Book[] = [];

    // Find containers by finding all book/md5 links
    const bookLinks = $('a[href*="/books/"], a[href*="/md5/"]').toArray();
    const seenContainers = new Set();

    for (const linkEl of bookLinks) {
      const link = $(linkEl);
      const containerEl = link.closest('div.flex').get(0) || link.parent().get(0);
      if (!containerEl || seenContainers.has(containerEl)) continue;
      seenContainers.add(containerEl);

      const container = $(containerEl);

      // Extract link href (could be /md5/... or /books/...)
      const mainLink = container.find('a[href*="/books/"], a[href*="/md5/"]').first();
      const href = mainLink.attr('href') || '';

      // Try extracting 32-char MD5 from href
      const md5Match = href.match(/\/(?:md5|books)\/([a-f0-9]{32})/i);
      let md5 = md5Match ? md5Match[1].toLowerCase() : undefined;

      // Fallback: check img src for 32-char MD5 hex
      if (!md5) {
        const imgSrc = container.find('img').first().attr('src') || '';
        const imgMatch = imgSrc.match(/\/([a-f0-9]{32})\.(?:webp|jpg|png)/i);
        if (imgMatch) {
          md5 = imgMatch[1].toLowerCase();
        }
      }

      // Fallback: check any 32-char hex in href or ID
      if (!md5) {
        const anyHexMatch = href.match(/([a-f0-9]{32})/i);
        if (anyHexMatch) {
          md5 = anyHexMatch[1].toLowerCase();
        } else {
          // Use ID from /books/12345678 if no MD5 available
          const idMatch = href.match(/\/books\/([^/]+)/);
          if (idMatch) {
            md5 = idMatch[1];
          }
        }
      }

      if (!md5) continue;

      // Extract title (from h3 a or font-semibold or first book link)
      const titleEl = container.find('h3 a, a.font-semibold').first();
      let title = titleEl.text().trim();
      if (!title) {
        title = container.find('a[href*="/books/"], a[href*="/md5/"]').last().text().trim();
      }

      if (!title || title.length < 2) continue;

      // Extract authors
      const authorLink = container.find('a[href*="/search?q="]').first();
      let authorText = authorLink.text().trim();
      if (!authorText) {
        const subText = container.find('div.text-sm, .text-gray-500').first().text();
        authorText = subText.split('·')[0].trim();
      }
      const authors = authorText && !authorText.toLowerCase().includes('unknown author')
        ? authorText.split(/[,;&]/).map((a: string) => a.trim()).filter((a: string) => a)
        : undefined;

      // Extract publisher/edition info
      const publisherLink = container.find('a[href*="/search?q="] .icon-\\[mdi--company\\]').parent();
      const publisher = publisherLink.text().trim();

      // Extract description
      const descDiv = container.find('div[class*="line-clamp"]').not('.font-mono').first();
      const description = descDiv.text().trim();

      // Extract cover URL and transform it
      const img = container.find('img').first();
      const originalCoverUrl = img.attr('src');
      const coverUrl = transformImageUrlToProxy(originalCoverUrl);

      // Extract filename
      const filenameDiv = container.find('div[class*="font-mono"]').first();
      const fullPath = filenameDiv.text().trim();
      const filename = fullPath ? (fullPath.split(/[/\\]/).pop() || fullPath) : undefined;

      // Extract metadata text
      const containerText = container.text().replace(/\s+/g, ' ').trim();

      const languageMatch = containerText.match(/✅\s*([A-Za-z]+)\s*\[([a-z]{2,3})\]/);
      const language = languageMatch ? languageMatch[2] : undefined;

      const formatMatch = containerText.match(/·\s*(PDF|EPUB|MOBI|DOC|DOCX|ZIP|AZW3|FB2|TXT)\s*·/i);
      const format = formatMatch ? formatMatch[1].toUpperCase() : undefined;

      const sizeMatch = containerText.match(/·\s*([\d.]+)\s*([KMG]?B)\s*·/i);
      let size: number | undefined = undefined;
      if (sizeMatch) {
        const value = parseFloat(sizeMatch[1]);
        const unit = sizeMatch[2].toUpperCase();
        if (unit === 'GB') size = Math.round(value * 1024 * 1024 * 1024);
        else if (unit === 'MB') size = Math.round(value * 1024 * 1024);
        else if (unit === 'KB') size = Math.round(value * 1024);
        else if (unit === 'B') size = Math.round(value);
      }

      const yearMatch = containerText.match(/·\s*(19|20)\d{2}\s*·/);
      const year = yearMatch ? parseInt(yearMatch[0].replace(/·/g, '').trim()) : undefined;

      const contentTypeMatch = containerText.match(/(📘|📕|📗|📰|💬|📝|🎶|🤨)\s*(Book\s*\([^)]+\)|Magazine|Comic\s*book|Standards\s*document|Musical\s*score|Other)/i);
      const contentType = contentTypeMatch ? contentTypeMatch[2] : undefined;

      const sourceMatch = containerText.match(/🚀\/([a-z/]+)/);
      const source = sourceMatch ? sourceMatch[1] : undefined;

      books.push({
        md5,
        title,
        authors,
        publisher: publisher || undefined,
        description: description || undefined,
        coverUrl: coverUrl || undefined,
        filename: filename || undefined,
        language,
        format,
        size,
        year,
        contentType,
        source,
      });
    }

    return books;
  }

  private static parsePagination($: CheerioRoot): { page: number; per_page: number; has_next: boolean; has_previous: boolean; estimated_total_results: number | null } {
    // Find current page (the link with aria-current="page")
    const currentPageLink = $('a[aria-current="page"]').first();
    const currentText = currentPageLink.text().trim();
    const page = currentText ? parseInt(currentText) || 1 : 1;

    // Check for Next button - look for link containing "Next" text
    const nextLink = $('a.js-pagination-next-page, a:contains("Next")').first();
    const has_next = nextLink.length > 0 && nextLink.attr('href') !== undefined;

    // Check for Previous button - look for link containing "Previous" text that's not disabled
    const prevLink = $('a.js-pagination-prev-page, a:contains("Previous")').first();
    const has_previous = prevLink.length > 0 && prevLink.attr('href') !== undefined;

    // Extract estimated total from "RESULTS X-Y (Z+ TOTAL)"
    const bodyText = $('body').text();
    const resultsMatch = bodyText.match(/RESULTS\s+\d+-\d+\s+\((\d+)\+?\s+TOTAL\)/i);
    const estimated_total_results = resultsMatch ? parseInt(resultsMatch[1]) : null;

    return {
      page,
      per_page: 50, // AA shows 50 results per page
      has_next,
      has_previous,
      estimated_total_results,
    };
  }

  async search(query: SearchQuery): Promise<SearchResponse> {
    const searchId = Math.random().toString(36).substring(7);

    // Check cache first
    logger.info(`[${searchId}] Checking cache for page ${query.page}...`);
    const cacheStart = Date.now();
    const cached = await searchCacheManager.get(query);
    const cacheDuration = Date.now() - cacheStart;

    if (cached) {
      logger.info(`[${searchId}] Cache hit! (${cacheDuration}ms) - returning ${cached.results.length} results`);
      return cached;
    }

    logger.info(`[${searchId}] Cache miss (${cacheDuration}ms)`);

    // Cache miss - scrape the page
    const url = this.buildSearchUrl(query);
    logger.info(`[${searchId}] URL: ${url}`);

    const result = await this.scrapeUrl(url);

    if (result.results.length === 0) {
      logger.warn(`[${searchId}] No results found`);
    } else {
      logger.success(`[${searchId}] Found ${result.results.length} books`);

      // Cache the result
      const cacheSetStart = Date.now();
      await searchCacheManager.set(query, result);
      logger.info(`[${searchId}] Cached result (${Date.now() - cacheSetStart}ms)`);
    }

    return result;
  }

  private buildSearchUrl(query: SearchQuery): string {
    const baseUrl = (process.env.AA_BASE_URL || BASE_URL || 'https://annas-archive.is').replace(/\/+$/, '');
    const params = new URLSearchParams();

    params.append('q', query.q);
    params.append('page', query.page.toString());

    if (query.sort) {
      params.append('sort', query.sort);
    }

    if (query.desc) {
      params.append('desc', '1');
    }

    // Handle array filters
    if (query.content) {
      query.content.forEach(c => params.append('content', c));
    }

    if (query.ext) {
      query.ext.forEach(e => params.append('ext', e));
    }

    if (query.acc) {
      query.acc.forEach(a => params.append('acc', a));
    }

    if (query.src) {
      query.src.forEach(s => params.append('src', s));
    }

    if (query.lang) {
      query.lang.forEach(l => params.append('lang', l));
    }

    return `${baseUrl}/search?${params.toString()}`;
  }
}

// Singleton instance
export const aaScraper = new AAScraper();
