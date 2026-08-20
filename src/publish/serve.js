import { createServer } from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';

const TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.webp': 'image/webp',
    '.ico': 'image/x-icon',
};

/**
 * Minimal static server for previewing the built site locally.
 *
 * Not for production — GitHub Pages serves the real thing. This exists so the site
 * can be checked before deploying, and so Phase 4 has something to develop against.
 */
export function serve({ dir = 'dist', port = 8080 } = {}) {
    const root = resolve(dir);

    const server = createServer((req, res) => {
        // Strip the query string, decode, and normalise before touching the disk.
        const raw = decodeURIComponent((req.url ?? '/').split('?')[0]);
        const rel = normalize(raw).replace(/^([/\\])+/, '');
        const target = resolve(root, rel);

        // Refuse anything that escapes the root, however it was encoded.
        if (target !== root && !target.startsWith(root + sep)) {
            res.writeHead(403).end('Forbidden');
            return;
        }

        let file = target;
        try {
            if (statSync(file).isDirectory()) file = join(file, 'index.html');
            statSync(file);
        } catch {
            res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
            return;
        }

        res.writeHead(200, {
            'content-type': TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
            'cache-control': 'no-cache',
        });
        createReadStream(file).pipe(res);
    });

    server.listen(port, () => {
        console.log(`Serving ${root} at http://localhost:${port}`);
        console.log('Ctrl-C to stop.');
    });
    return server;
}
