import { serve } from 'bun';
import { dirname, join } from 'node:path';

const root = dirname(new URL(import.meta.url).pathname);
const appDir = join(root, 'hue-app');

const server = serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    let pathname = url.pathname;
    if (pathname === '/') pathname = '/index.html';
    if (pathname.endsWith('/')) pathname += 'index.html';

    console.log(`${req.method} ${pathname}`);

    const file = Bun.file(join(appDir, pathname));
    const exists = await file.exists();
    if (!exists) {
      return new Response('Not found', { status: 404 });
    }

    return new Response(file);
  },
});

console.log(`\n  http://localhost:${server.port}\n`);