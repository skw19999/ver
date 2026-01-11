import { Hono } from 'hono'
import { handle } from 'hono/vercel'
import { getCookie, setCookie } from 'hono/cookie'
import { kv } from '@vercel/kv'

// Vercel Edge Runtime ကိုအသုံးပြုမည် (Streaming အတွက်အရေးကြီးသည်)
export const config = {
  runtime: 'edge'
}

const app = new Hono().basePath('/api')

// =======================
// CONFIGURATION
// =======================
const ACCESS_PASSWORD = "1234"; 

// =======================
// 1. UI & AUTH
// =======================
app.get('/', (c) => {
  const auth = getCookie(c, "auth_token");
  if (auth === ACCESS_PASSWORD) return c.html(renderApp());
  return c.html(renderLogin());
});

app.post('/login', async (c) => {
  const body = await c.req.parseBody();
  if (body.password === ACCESS_PASSWORD) {
    setCookie(c, "auth_token", ACCESS_PASSWORD, { path: "/", maxAge: 86400 * 7 });
    return c.redirect('/api');
  }
  return c.html(renderLogin(true));
});

// =======================
// 2. CREATE LINK API
// =======================
app.post('/create', async (c) => {
    const auth = getCookie(c, "auth_token");
    if (auth !== ACCESS_PASSWORD) return c.json({ success: false, error: "Unauthorized" }, 401);

    const body = await c.req.parseBody();
    const originalUrl = body.url as string;
    let fileName = body.name as string;

    if (!originalUrl) return c.json({ success: false, error: "Missing URL" });

    fileName = fileName.trim().replace(/[^a-zA-Z0-9._-]/g, "_"); 
    if (!fileName.match(/\.(mp4|mkv|mov|avi|zip|rar)$/i)) fileName += ".mp4";

    // Vercel KV Check
    const exists = await kv.exists(`media:${fileName}`);
    if (exists) {
        return c.json({ success: false, error: "Filename already exists!" });
    }

    const type = originalUrl.includes("mediafire.com") ? "mediafire" : "direct";

    // Store in Vercel KV (Redis)
    await kv.set(`media:${fileName}`, { 
        url: originalUrl, 
        type: type,
        views: 0 
    });

    // Construct URL
    const host = c.req.header('host');
    const protocol = host?.includes('localhost') ? 'http' : 'https';
    const fullUrl = `${protocol}://${host}/api/${fileName}`;
    
    return c.json({ success: true, link: fullUrl });
});

// =======================
// 3. UNIVERSAL PROXY ENGINE (EDGE)
// =======================
app.get('/:filename', async (c) => {
    return handleRequest(c, c.req.param("filename"), "GET");
});

// Handling HEAD request for Players
app.on('HEAD', '/:filename', async (c) => {
    return handleRequest(c, c.req.param("filename"), "HEAD");
})

async function handleRequest(c: any, filename: string, method: string) {
    // 1. Get Data from Vercel KV
    const fileData = await kv.get(`media:${filename}`) as any;

    if (!fileData) return c.text("File Not Found", 404);

    let finalStreamUrl = null;

    // 2. Logic Separation
    if (fileData.type === "mediafire") {
        // Cache Check
        const cacheKey = `cache:${filename}`;
        const cachedLink = await kv.get(cacheKey) as string;
        
        if (cachedLink) {
            finalStreamUrl = cachedLink;
        } else {
            // Scrape Logic
            try {
                const pageRes = await fetch(fileData.url, {
                    headers: { "User-Agent": "Mozilla/5.0" }
                });
                const html = await pageRes.text();
                let match = html.match(/aria-label="Download file"\s+href="([^"]+)"/);
                if (!match) match = html.match(/id="downloadButton"\s+href="([^"]+)"/);
                
                if (match && match[1]) {
                    finalStreamUrl = match[1];
                    // Cache for 3 hours (EX = seconds)
                    await kv.set(cacheKey, finalStreamUrl, { ex: 10800 });
                } else {
                    return c.text("MediaFire File Removed", 404);
                }
            } catch (e) {
                return c.text("Scraping Error", 502);
            }
        }
    } else {
        finalStreamUrl = fileData.url;
    }

    // 3. Proxy Streaming (Using Standard Web Fetch in Edge)
    try {
        const rangeHeader = c.req.header("range");
        const fetchHeaders = new Headers({ 
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" 
        });
        if (rangeHeader) fetchHeaders.set("Range", rangeHeader);

        const fileRes = await fetch(finalStreamUrl, { 
            method: method,
            headers: fetchHeaders 
        });

        const newHeaders = new Headers();
        
        // Essential Headers
        ["content-type", "content-length", "content-range", "accept-ranges", "last-modified", "etag"].forEach(h => {
            if (fileRes.headers.has(h)) newHeaders.set(h, fileRes.headers.get(h));
        });

        newHeaders.set("Content-Disposition", `attachment; filename="${filename}"`);
        newHeaders.set("Access-Control-Allow-Origin", "*");
        newHeaders.set("Accept-Ranges", "bytes");

        if (method === "HEAD") {
            return new Response(null, { status: 200, headers: newHeaders });
        }

        // Return Stream
        return new Response(fileRes.body, {
            status: fileRes.status,
            headers: newHeaders
        });

    } catch (e: any) {
        return c.text("Stream Error: " + e.message, 502);
    }
}

// =======================
// UI HTML (Minified)
// =======================
function renderLogin(e=false){return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Login</title><script src="https://cdn.tailwindcss.com"></script></head><body class="bg-black text-white min-h-screen flex items-center justify-center"><div class="max-w-sm w-full bg-gray-900 p-8 rounded-xl border border-gray-800 text-center"><h2 class="text-xl font-bold mb-4">Vercel Proxy</h2>${e?'<p class="text-red-500 text-sm mb-4">Wrong Password!</p>':''}<form action="/api/login" method="POST" class="space-y-4"><input type="password" name="password" placeholder="Pass" class="w-full bg-black border border-gray-700 rounded px-4 py-2" required/><button class="w-full bg-white text-black font-bold py-2 rounded">Login</button></form></div></body></html>`;}

function renderApp() {
  return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Vercel Proxy Gen</title>
      <script src="https://cdn.tailwindcss.com"></script>
    </head>
    <body class="bg-black text-white min-h-screen flex items-center justify-center p-4">
      <div class="w-full max-w-lg bg-gray-900 p-8 rounded-2xl border border-gray-800">
        <h1 class="text-2xl font-bold text-center mb-6">⚡ Vercel Edge Proxy</h1>
        <div class="space-y-4">
            <input id="mf-link" type="text" placeholder="MediaFire / Direct URL" class="w-full bg-black border border-gray-700 rounded-lg px-4 py-2" />
            <input id="file-name" type="text" placeholder="Filename" class="w-full bg-black border border-gray-700 rounded-lg px-4 py-2" />
            <button onclick="saveLink()" id="btn" class="w-full bg-white text-black font-bold py-2 rounded-lg hover:bg-gray-200">Generate</button>
        </div>
        <div id="result" class="mt-6 hidden">
             <input id="final-link" readonly class="w-full bg-black border border-green-900 text-green-500 rounded px-2 py-1 text-sm mb-2" />
             <a id="test-btn" href="#" class="text-xs text-gray-400 underline">Test Download</a>
        </div>
      </div>
      <script>
        async function saveLink() {
            const url = document.getElementById('mf-link').value;
            const name = document.getElementById('file-name').value;
            const btn = document.getElementById('btn');
            if(!url || !name) return alert("Fill all fields");
            btn.innerText = "..."; btn.disabled = true;
            try {
                const res = await fetch("/api/create", {
                    method: "POST",
                    headers: { "Content-Type": "application/x-www-form-urlencoded" },
                    body: new URLSearchParams({ url, name })
                });
                const data = await res.json();
                if(data.success) {
                    document.getElementById('final-link').value = data.link;
                    document.getElementById('test-btn').href = data.link;
                    document.getElementById('result').classList.remove('hidden');
                } else alert(data.error);
            } catch(e) { alert("Error"); }
            btn.innerText = "Generate"; btn.disabled = false;
        }
      </script>
    </body>
    </html>
  `;
}

export default handle(app)
