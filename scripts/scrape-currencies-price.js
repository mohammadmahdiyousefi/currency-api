#!/usr/bin/env node
'use strict';

/**
 * Alanchand Currency Scraper
 * ---------------------------
 * Downloads the currency price table from alanchand.com, extracts the
 * "sell price" and the price trend (up / down / no_change) for every
 * currency row, and writes the result to public/currencies.json.
 *
 * Structure follows SOLID-ish separation of concerns:
 *   - HttpClient            -> knows how to fetch a URL over HTTP(S)
 *   - PersianDigitNormalizer/PriceParser -> knows how to parse a raw price string
 *   - CurrencyHtmlParser    -> knows how to read currencies out of the page HTML
 *   - CurrencyValidator     -> knows how to dedupe/validate the extracted data
 *   - CurrencyFileRepository-> knows how to persist the result to disk
 *   - CurrencyScraperService-> orchestrates the above (depends on abstractions,
 *                              injected in main()), it doesn't know HOW each
 *                              step works internally.
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

/* ============================================================
 * Configuration
 * ============================================================ */

const CONFIG = {
  sourceUrl: 'https://alanchand.com/currencies-price',
  outputDir: path.join(process.cwd(), 'public'),
  outputFile: 'currencies.json',
  requestTimeoutMs: 15000,
  maxRedirects: 5,
  maxHtmlSizeBytes: 10 * 1024 * 1024, // 10 MB safety cap against runaway/garbage responses
  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/153 Safari/537.36',
};

// The three trend states the source website can report for a currency row,
// taken straight from the "priceSymbol" span's class attribute.
const PRICE_TREND = {
  UP: 'up',
  DOWN: 'down',
  NO_CHANGE: 'no_change',
};

const VALID_PRICE_TRENDS = Object.values(PRICE_TREND);

/* ============================================================
 * Number parsing utilities
 * ============================================================ */

/**
 * Converts Persian (۰-۹) and Arabic-Indic (٠-٩) digits found inside a
 * string into standard ASCII digits (0-9), so the value can later be
 * parsed as a JavaScript number.
 */
class PersianDigitNormalizer {
  static PERSIAN_DIGITS = '۰۱۲۳۴۵۶۷۸۹';
  static ARABIC_DIGITS = '٠١٢٣٤٥٦٧٨٩';

  static normalize(value) {
    if (typeof value !== 'string') {
      return '';
    }

    return value
      .replace(/[۰-۹]/g, (digit) => String(PersianDigitNormalizer.PERSIAN_DIGITS.indexOf(digit)))
      .replace(/[٠-٩]/g, (digit) => String(PersianDigitNormalizer.ARABIC_DIGITS.indexOf(digit)));
  }
}

/**
 * Parses a raw, messy price string (Persian/Arabic digits, thousands
 * separators, stray whitespace, possibly a decimal part) into a safe
 * integer price. Returns null when the value can't be parsed with
 * confidence, so the caller can skip the row instead of storing garbage.
 */
class PriceParser {
  static parse(rawValue) {
    if (!rawValue) {
      return null;
    }

    const normalized = PersianDigitNormalizer.normalize(rawValue).trim();

    // Thousands separators we may see: ',', Arabic thousands separator
    // (U+066C), regular spaces and non-breaking spaces.
    const withoutThousandsSeparators = normalized.replace(/[,\u066C\s\u00A0]/g, '');

    // Normalize the Arabic decimal separator (U+066B) to a plain dot so
    // the value can be parsed as a standard float below.
    const withDotDecimal = withoutThousandsSeparators.replace(/[\u066B]/g, '.');

    // Anything other than digits and (optionally) a single decimal point
    // means the cell didn't contain a clean price (e.g. "N/A", "-").
    if (!/^\d+(\.\d+)?$/.test(withDotDecimal)) {
      return null;
    }

    const price = Number(withDotDecimal);

    if (!Number.isFinite(price) || price <= 0) {
      return null;
    }

    // Round to the nearest integer instead of mangling the digits.
    const roundedPrice = Math.round(price);

    if (!Number.isSafeInteger(roundedPrice)) {
      return null;
    }

    return roundedPrice;
  }
}

/* ============================================================
 * HTTP client
 * ============================================================ */

/**
 * Small HTTP(S) client dedicated to fetching a page as text, with the
 * safety nets the original inline implementation was missing:
 *   - a request timeout (so the script can never hang forever)
 *   - a bounded number of redirects (so it can never loop forever)
 *   - correct resolution of *relative* redirect locations
 *   - a cap on response size (basic protection against huge/garbage bodies)
 */
class HttpClient {
  constructor({ timeoutMs, maxRedirects, userAgent, maxBodyBytes }) {
    this.timeoutMs = timeoutMs;
    this.maxRedirects = maxRedirects;
    this.userAgent = userAgent;
    this.maxBodyBytes = maxBodyBytes;
  }

  fetchText(targetUrl, redirectsLeft = this.maxRedirects) {
    return new Promise((resolve, reject) => {
      let parsedUrl;

      try {
        parsedUrl = new URL(targetUrl);
      } catch (err) {
        reject(new Error(`Invalid URL: ${targetUrl}`));
        return;
      }

      const client = parsedUrl.protocol === 'http:' ? http : https;

      const request = client.get(
        parsedUrl,
        {
          headers: {
            'User-Agent': this.userAgent,
            Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'fa-IR,fa;q=0.9,en-US;q=0.8,en;q=0.7',
          },
        },
        (response) => this._handleResponse(response, parsedUrl, redirectsLeft, resolve, reject),
      );

      // Timeout so a stalled connection cannot hang the whole pipeline forever.
      request.setTimeout(this.timeoutMs, () => {
        request.destroy(new Error(`Request timed out after ${this.timeoutMs}ms: ${targetUrl}`));
      });

      request.on('error', (err) =>
        reject(new Error(`Network error while fetching ${targetUrl}: ${err.message}`)),
      );
    });
  }

  _handleResponse(response, requestUrl, redirectsLeft, resolve, reject) {
    const { statusCode, headers } = response;

    if (statusCode >= 300 && statusCode < 400 && headers.location) {
      response.resume(); // drain the body, we don't need it for a redirect

      if (redirectsLeft <= 0) {
        reject(new Error(`Too many redirects while fetching ${requestUrl.href}`));
        return;
      }

      // Location can be a relative path; resolve it against the current URL.
      let nextUrl;
      try {
        nextUrl = new URL(headers.location, requestUrl).toString();
      } catch (err) {
        reject(new Error(`Invalid redirect location "${headers.location}" from ${requestUrl.href}`));
        return;
      }

      this.fetchText(nextUrl, redirectsLeft - 1).then(resolve).catch(reject);
      return;
    }

    if (statusCode !== 200) {
      response.resume();
      reject(new Error(`Source website returned HTTP ${statusCode} for ${requestUrl.href}`));
      return;
    }

    const contentType = headers['content-type'] || '';
    if (contentType && !contentType.includes('text/html') && !contentType.includes('text/plain')) {
      console.warn(`WARNING: unexpected content-type "${contentType}" for ${requestUrl.href}`);
    }

    let html = '';
    let receivedBytes = 0;
    let aborted = false;

    response.setEncoding('utf8');

    response.on('data', (chunk) => {
      if (aborted) return;

      receivedBytes += Buffer.byteLength(chunk, 'utf8');

      if (receivedBytes > this.maxBodyBytes) {
        aborted = true;
        response.destroy();
        reject(new Error(`Response body exceeded ${this.maxBodyBytes} byte limit`));
        return;
      }

      html += chunk;
    });

    response.on('end', () => {
      if (aborted) return;
      resolve(html);
    });

    response.on('error', (err) => {
      if (aborted) return;
      reject(new Error(`Error while reading response body: ${err.message}`));
    });
  }
}

/* ============================================================
 * HTML parsing
 * ============================================================ */

/**
 * Extracts { name, price, priceChange } objects out of the raw currency
 * table HTML.
 *
 * The page markup looks roughly like:
 *
 *   <tr onclick="window.location='https://alanchand.com/currencies-price/usd'">
 *     ...
 *     <td class="sellPrice text-center">
 *       ۲۲۸,۹۰۰<span class="priceSymbol down"></span>
 *     </td>
 *   </tr>
 *
 * The "priceSymbol" span carries one of three classes:
 *   - "up"        -> price increased
 *   - "down"      -> price decreased
 *   - "no_change" -> price stayed the same
 *
 * NOTE: this stays a lightweight regex-based parser (no extra
 * dependency), but each row is parsed defensively: a row that doesn't
 * match the expected shape is skipped with a warning instead of
 * crashing the whole run, since the upstream markup is outside our
 * control and can shift slightly at any time.
 */
class CurrencyHtmlParser {
  parse(html) {
    const currencies = [];
    const rowRegex = /<tr\b[^>]*>[\s\S]*?<\/tr>/gi;
    const rows = html.match(rowRegex) || [];

    console.log(`Table rows found: ${rows.length}`);

    for (const rowHtml of rows) {
      const currency = this._parseRow(rowHtml);
      if (currency) {
        currencies.push(currency);
      }
    }

    return currencies;
  }

  _parseRow(rowHtml) {
    // Currency slug comes from the row's link, e.g. "currencies-price/usd".
    const nameMatch = rowHtml.match(/currencies-price\/([a-z0-9-]+)['"]/i);
    if (!nameMatch) {
      return null; // Not a currency row (e.g. a header row) — skip silently.
    }

    const name = nameMatch[1].toLowerCase();

    const sellPriceMatch = rowHtml.match(
      /<td\b[^>]*class=["'][^"']*\bsellPrice\b[^"']*["'][^>]*>([\s\S]*?)<\/td>/i,
    );

    if (!sellPriceMatch) {
      console.warn(`WARNING: sellPrice cell not found for "${name}"`);
      return null;
    }

    const cellHtml = sellPriceMatch[1];

    // Determine the price trend from the "priceSymbol" span's class.
    // Matches exactly one of: up | down | no_change.
    const symbolMatch = cellHtml.match(
      /class=["'][^"']*\bpriceSymbol\b[^"']*\b(up|down|no_change)\b/i,
    );

    let priceChange;

    if (symbolMatch) {
      priceChange = symbolMatch[1].toLowerCase();
    } else {
      console.warn(
        `WARNING: priceSymbol class not found for "${name}", defaulting to "${PRICE_TREND.NO_CHANGE}"`,
      );
      priceChange = PRICE_TREND.NO_CHANGE;
    }

    // Strip any nested tags (e.g. <span class="priceSymbol">) to get plain text.
    const sellPriceText = cellHtml.replace(/<[^>]*>/g, ' ').trim();
    const price = PriceParser.parse(sellPriceText);

    if (price === null) {
      console.warn(`WARNING: invalid sellPrice for "${name}": "${sellPriceText}"`);
      return null;
    }

    return { name, price, priceChange };
  }
}

/* ============================================================
 * Validation
 * ============================================================ */

class CurrencyValidator {
  constructor() {}

  /**
   * Removes duplicate rows for the same currency.
   * Keeps the FIRST occurrence of each name.
   */
  deduplicate(currencies) {
    const seen = new Map();

    for (const currency of currencies) {
      if (!seen.has(currency.name)) {
        seen.set(currency.name, currency);
      }
    }

    return Array.from(seen.values());
  }

  /**
   * Throws when there is literally nothing to publish (0 currencies) or
   * when a row's data is internally inconsistent (bad name/price/priceChange).
   * Any non-zero count (1, 10, 100, ...) is accepted — a low count is not
   * on its own a reason to block publishing, only an empty result is.
   */
  validate(currencies) {
    if (currencies.length === 0) {
      throw new Error('No currencies were found. The page structure may have changed.');
    }

    for (const currency of currencies) {
      if (typeof currency.name !== 'string' || currency.name.length === 0) {
        throw new Error('Invalid currency name detected.');
      }

      if (!Number.isSafeInteger(currency.price) || currency.price <= 0) {
        throw new Error(`Invalid price for currency "${currency.name}": ${currency.price}`);
      }

      if (!VALID_PRICE_TRENDS.includes(currency.priceChange)) {
        throw new Error(
          `Invalid "priceChange" for currency "${currency.name}": ${currency.priceChange}`,
        );
      }
    }
  }
}

/* ============================================================
 * Persistence
 * ============================================================ */

class CurrencyFileRepository {
  constructor(outputDir, outputFileName) {
    this.outputDir = outputDir;
    this.outputPath = path.join(outputDir, outputFileName);
  }

  /**
   * Persists the scraped data as pretty-printed JSON.
   * Writes to a temporary file first, then renames it into place
   * for atomic replacement.
   */
  save({ updateDate, currencies }) {
    const payload = { update_date: updateDate, currencies };
    const json = JSON.stringify(payload, null, 2);

    fs.mkdirSync(this.outputDir, { recursive: true });

    const tempPath = `${this.outputPath}.tmp-${process.pid}`;
    fs.writeFileSync(tempPath, json, 'utf8');
    fs.renameSync(tempPath, this.outputPath);

    return this.outputPath;
  }
}

/* ============================================================
 * Orchestration
 * ============================================================ */

/**
 * Coordinates the scraping pipeline. Depends only on the abstractions
 * above (injected via the constructor), not on their internals.
 */
class CurrencyScraperService {
  constructor({ httpClient, parser, validator, repository, sourceUrl }) {
    this.httpClient = httpClient;
    this.parser = parser;
    this.validator = validator;
    this.repository = repository;
    this.sourceUrl = sourceUrl;
  }

  async run() {
    console.log('========================================');
    console.log('Alanchand Currency API');
    console.log('========================================');
    console.log(`Source: ${this.sourceUrl}`);
    console.log('');

    console.log('Downloading website...');
    const html = await this.httpClient.fetchText(this.sourceUrl);
    console.log(`HTML size: ${html.length} bytes`);
    console.log('');

    console.log('Extracting currencies...');
    const rawCurrencies = this.parser.parse(html);
    const currencies = this.validator.deduplicate(rawCurrencies);

    console.log('');
    console.log(`Currencies found: ${currencies.length}`);
    console.log('');

    this.validator.validate(currencies);

    console.log('Extracted prices:');
    console.log('');

    const TREND_ARROW = {
      [PRICE_TREND.UP]: '▲',
      [PRICE_TREND.DOWN]: '▼',
      [PRICE_TREND.NO_CHANGE]: '=',
    };

    for (const currency of currencies) {
      const arrow = TREND_ARROW[currency.priceChange] || '?';
      console.log(`${currency.name.padEnd(25)} ${String(currency.price).padStart(10)}  ${arrow}`);
    }

    // Timestamp is recorded only after validation passes.
    const updateDate = new Date().toISOString();
    const outputPath = this.repository.save({ updateDate, currencies });

    console.log('');
    console.log('========================================');
    console.log('Scraping completed successfully.');
    console.log(`Update date: ${updateDate}`);
    console.log(`Currencies: ${currencies.length}`);
    console.log(`Output: ${outputPath}`);
    console.log('========================================');
  }
}

/* ============================================================
 * Entry point
 * ============================================================ */

async function main() {
  const httpClient = new HttpClient({
    timeoutMs: CONFIG.requestTimeoutMs,
    maxRedirects: CONFIG.maxRedirects,
    userAgent: CONFIG.userAgent,
    maxBodyBytes: CONFIG.maxHtmlSizeBytes,
  });

  const service = new CurrencyScraperService({
    httpClient,
    parser: new CurrencyHtmlParser(),
    validator: new CurrencyValidator(),
    repository: new CurrencyFileRepository(CONFIG.outputDir, CONFIG.outputFile),
    sourceUrl: CONFIG.sourceUrl,
  });

  await service.run();
}

main().catch((error) => {
  console.error('');
  console.error('========================================');
  console.error('SCRAPER FAILED');
  console.error('========================================');
  console.error(error && error.message ? error.message : error);
  console.error('');
  process.exit(1);
});
