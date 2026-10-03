import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, dirname, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json' };
http.createServer(async (req, res) => {
    try {
        const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
        if (pathname === '/') { res.writeHead(302, { Location: '/tests/fixture.html' }).end(); return; }
        const path = resolve(root, `.${pathname}`);
        if (!path.startsWith(root + sep) || !types[extname(path)]) { res.writeHead(404).end(); return; }
        const content = await readFile(path);
        res.writeHead(200, { 'Content-Type': types[extname(path)], 'Cache-Control': 'no-store' });
        res.end(content);
    } catch { res.writeHead(404).end(); }
}).listen(8766, '127.0.0.1', () => console.log('Toolbox test fixture: http://127.0.0.1:8766'));
