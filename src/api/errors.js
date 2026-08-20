/**
 * Typed errors for the Limitless API.
 *
 * The prototype swallowed every failure into `return []`, which meant a network
 * blip was indistinguishable from "player not found" — and since `[] != -1` is
 * true, failed requests were recorded as successful lookups. Corrupt data, silently.
 *
 * Here nothing is swallowed. Each error carries a `retryable` flag so the crawler
 * can decide: back off and retry, skip and record, or abort.
 */

export class ApiError extends Error {
    /** @param {{ status?: number, url?: string, retryable?: boolean, cause?: unknown }} opts */
    constructor(message, { status, url, retryable = false, cause } = {}) {
        super(message, { cause });
        this.name = 'ApiError';
        this.status = status;
        this.url = url;
        this.retryable = retryable;
    }
}

/** 404 — the tournament exists in a listing but has no standings, or was deleted. Skip it, don't retry. */
export class NotFoundError extends ApiError {
    constructor(url) {
        super(`Not found: ${url}`, { status: 404, url, retryable: false });
        this.name = 'NotFoundError';
    }
}

/** 429 — over the 50-in-5min budget. Always retryable; `retryAfterMs` says how long to wait. */
export class RateLimitError extends ApiError {
    constructor(url, retryAfterMs) {
        super(`Rate limited on ${url}; retry in ${Math.ceil(retryAfterMs / 1000)}s`, {
            status: 429,
            url,
            retryable: true,
        });
        this.name = 'RateLimitError';
        this.retryAfterMs = retryAfterMs;
    }
}

/** The request succeeded but the body wasn't the shape we expect. Never retryable — retrying can't fix a schema change. */
export class MalformedResponseError extends ApiError {
    constructor(url, detail) {
        super(`Malformed response from ${url}: ${detail}`, { url, retryable: false });
        this.name = 'MalformedResponseError';
    }
}
