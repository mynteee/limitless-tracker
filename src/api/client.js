import { setTimeout as sleep } from 'node:timers/promises';
import { ApiError, MalformedResponseError, NotFoundError, RateLimitError } from './errors.js';

/**
 * The live API advertises: RateLimit: "50-in-5min"; r=49; t=300
 * 50 requests per 5 minutes — one every 6 seconds. Every outbound request in this
 * project goes through here so that budget can never be blown by accident.
 */
const DEFAULT_CAPACITY = 50;
const DEFAULT_WINDOW_MS = 5 * 60 * 1000;

/**
 * Token bucket that also listens to the server.
 *
 * A purely local counter drifts: the budget may be shared with another process, a
 * previous run may have spent it, or the limit itself may change. So we pace locally
 * and resync from the RateLimit response headers after every call, always taking the
 * more conservative of the two views.
 */
export class RateLimiter {
    constructor({ capacity = DEFAULT_CAPACITY, windowMs = DEFAULT_WINDOW_MS } = {}) {
        this.capacity = capacity;
        this.windowMs = windowMs;
        this.tokens = capacity;
        this.lastRefill = Date.now();
        /** Set when the server reports the budget exhausted; no request goes out before this. */
        this.blockedUntil = 0;
    }

    /** Milliseconds of credit earned per token. 300000/50 = 6000ms. */
    get intervalMs() {
        return this.windowMs / this.capacity;
    }

    #refill() {
        const now = Date.now();
        const gained = (now - this.lastRefill) / this.intervalMs;
        if (gained > 0) {
            this.tokens = Math.min(this.capacity, this.tokens + gained);
            this.lastRefill = now;
        }
    }

    /** Resolves once it is safe to send. Never returns without having spent a token. */
    async acquire() {
        for (;;) {
            const now = Date.now();
            if (now < this.blockedUntil) {
                await sleep(this.blockedUntil - now);
                continue;
            }
            this.#refill();
            if (this.tokens >= 1) {
                this.tokens -= 1;
                return;
            }
            await sleep(Math.ceil((1 - this.tokens) * this.intervalMs));
        }
    }

    /**
     * Fold the server accounting back into the bucket.
     *   RateLimit-Policy: "50-in-5min"; q=50; w=300   -> the quota and window
     *   RateLimit:        "50-in-5min"; r=49; t=300   -> remaining, and seconds to reset
     */
    observe(headers) {
        const policy = headers.get('ratelimit-policy');
        if (policy) {
            const quota = Number(policy.match(/\bq=(\d+)/)?.[1]);
            const windowSec = Number(policy.match(/\bw=(\d+)/)?.[1]);
            // Adapt automatically if Limitless ever changes the published limit.
            if (Number.isFinite(quota) && quota > 0) this.capacity = quota;
            if (Number.isFinite(windowSec) && windowSec > 0) this.windowMs = windowSec * 1000;
        }

        const limit = headers.get('ratelimit');
        if (!limit) return;
        const remaining = Number(limit.match(/\br=(\d+)/)?.[1]);
        const resetSec = Number(limit.match(/\bt=(\d+)/)?.[1]);
        if (!Number.isFinite(remaining)) return;

        // Trust the server whenever it is stricter than our local estimate.
        if (remaining < this.tokens) {
            this.tokens = remaining;
            this.lastRefill = Date.now();
        }
        // Budget spent: hold everything until the window rolls over.
        if (remaining <= 0 && Number.isFinite(resetSec)) {
            this.blockedUntil = Math.max(this.blockedUntil, Date.now() + resetSec * 1000);
        }
    }

    /** Hard stop after a 429, so the retry does not immediately spend another token. */
    penalize(ms) {
        this.blockedUntil = Math.max(this.blockedUntil, Date.now() + ms);
        this.tokens = 0;
    }
}

/** Exponential backoff with full jitter, so parallel retries do not resynchronise. */
function backoffMs(attempt, base = 1000, max = 60_000) {
    const ceiling = Math.min(max, base * 2 ** attempt);
    return Math.round(ceiling * (0.5 + Math.random() * 0.5));
}

function retryAfterMs(res) {
    const header = res.headers.get('retry-after');
    if (header) {
        const seconds = Number(header);
        if (Number.isFinite(seconds)) return seconds * 1000;
        const date = Date.parse(header);
        if (Number.isFinite(date)) return Math.max(0, date - Date.now());
    }
    // Fall back to the reset hint on the RateLimit header.
    const reset = Number(res.headers.get('ratelimit')?.match(/\bt=(\d+)/)?.[1]);
    return Number.isFinite(reset) ? reset * 1000 : null;
}

/**
 * A rate-limited, retrying JSON client. One instance per crawl run.
 */
export class ApiClient {
    /**
     * @param {object} [opts]
     * @param {string} [opts.baseUrl]
     * @param {number} [opts.maxRetries]
     * @param {string|null} [opts.apiKey] Sent as X-Access-Key. Unused today — the whole
     *   project works anonymously — but wired up so an approved key needs no code change.
     */
    constructor({
        baseUrl = 'https://play.limitlesstcg.com/api',
        maxRetries = 5,
        apiKey = process.env.LIMITLESS_API_KEY ?? null,
        limiter = new RateLimiter(),
    } = {}) {
        this.baseUrl = baseUrl.replace(/\/$/, '');
        this.maxRetries = maxRetries;
        this.apiKey = apiKey;
        this.limiter = limiter;
        this.stats = { requests: 0, retries: 0, rateLimitHits: 0 };
    }

    #headers() {
        const headers = {
            Accept: 'application/json',
            'User-Agent': 'limitless-tracker/0.1',
        };
        if (this.apiKey) headers['X-Access-Key'] = this.apiKey;
        return headers;
    }

    /**
     * GET a JSON endpoint.
     * @param {string} path e.g. '/tournaments'
     * @param {Record<string, string|number|undefined>} [params]
     * @returns {Promise<unknown>} parsed JSON
     * @throws {NotFoundError|RateLimitError|MalformedResponseError|ApiError} never a sentinel value
     */
    async get(path, params = {}) {
        const url = new URL(this.baseUrl + path);
        for (const [key, value] of Object.entries(params)) {
            if (value !== undefined && value !== null && value !== '') {
                url.searchParams.set(key, String(value));
            }
        }
        const href = url.href;

        for (let attempt = 0; ; attempt++) {
            await this.limiter.acquire();
            this.stats.requests += 1;

            let res;
            try {
                res = await fetch(href, { headers: this.#headers() });
            } catch (cause) {
                // DNS failure, socket reset, offline — transient by nature.
                if (attempt >= this.maxRetries) {
                    throw new ApiError(`Network failure after ${attempt + 1} attempts: ${href}`, {
                        url: href,
                        retryable: true,
                        cause,
                    });
                }
                this.stats.retries += 1;
                await sleep(backoffMs(attempt));
                continue;
            }

            this.limiter.observe(res.headers);

            if (res.ok) {
                try {
                    return await res.json();
                } catch (cause) {
                    throw new MalformedResponseError(href, `invalid JSON (${cause.message})`);
                }
            }

            if (res.status === 404) throw new NotFoundError(href);

            if (res.status === 429) {
                this.stats.rateLimitHits += 1;
                const waitMs = retryAfterMs(res) ?? backoffMs(attempt, 5000);
                this.limiter.penalize(waitMs);
                if (attempt >= this.maxRetries) throw new RateLimitError(href, waitMs);
                this.stats.retries += 1;
                continue; // acquire() now blocks until the penalty expires
            }

            if (res.status >= 500) {
                if (attempt >= this.maxRetries) {
                    throw new ApiError(`HTTP ${res.status} after ${attempt + 1} attempts: ${href}`, {
                        status: res.status,
                        url: href,
                        retryable: true,
                    });
                }
                this.stats.retries += 1;
                await sleep(backoffMs(attempt));
                continue;
            }

            // Any other 4xx is a client-side mistake; retrying cannot fix it.
            throw new ApiError(`HTTP ${res.status} ${res.statusText}: ${href}`, {
                status: res.status,
                url: href,
                retryable: false,
            });
        }
    }
}
