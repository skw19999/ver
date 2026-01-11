import { Hono } from 'hono'
import { handle } from 'hono/vercel'
import { getCookie, setCookie } from 'hono/cookie'
import { createClient } from '@vercel/kv' // Library ခေါ်ပုံ ပြောင်းထားသည်

export const runtime = 'edge';

const app = new Hono().basePath('')
const ACCESS_PASSWORD = "1234"; 

// ============================================
// DATABASE SETUP (UNIVERSAL)
// Variable နာမည် ဘယ်လိုလာလာ အလုပ်လုပ်မယ့် နည်းလမ်း
// ============================================
const kv = createClient({
  url: process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || "",
  token: process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || "",
});

app.get('/', (c) => {
  const auth = getCookie(c, "auth_token");
  if (auth === ACCESS_PASSWORD) return c.html(renderApp());
  return c.html(renderLogin());
});

app.post('/login', async (c) => {
  const body = await c.req.parseBody();
  if (body.password === ACCESS_PASSWORD) {
    setCookie(c, "auth_token", ACCESS_PASSWORD, { path: "/", maxAge: 86400 * 7 });
    return c.redirect('/'); 
  }
  return c.html(renderLogin(true));
});

app.post('/create', async (c) => {
    try {
        const auth = getCookie(c, "auth_token");
        if (auth !== ACCESS_PASSWORD) return c.json({ success: false, error: "Unauthorized" }, 401);

        const body = await c.req.parseBody();
        const originalUrl = body.url as string;
        let fileName = body.name as string;

        if (!originalUrl || !fileName) return c.json({ success: false, error: "URL and Name required" });

        // Database Connection Test
        try {
            await kv.set('test_db', 'ok');
        } catch (e) {
            return c.json({ success: false, error: "Database Connection Failed. Check Env Vars." });
        }

        fileName = fileName.trim().replace(/[^a-zA-Z0-9._-]/g, "_"); 
        if (!fileName.match(/\.(mp4|mkv|mov|avi|zip|rar)$/i)) fileName += ".mp4";

        const exists = await kv.exists(`media:${fileName}`);
        if (exists) return c.json({ success: false, error: "Filename already exists!" });

        const type = originalUrl.includes("mediafire.com") ? "mediafire" : "direct";
        await kv.set(`media:${fileName}`, { url: originalUrl, type: type, views: 0 });

        const host = c.req.header('host');
        const protocol = host?.includes('localhost') ? 'http' : 'https';
        const fullUrl = `${protocol}://${host}/${fileName}`;
        
        return c.json({ success: true, link: fullUrl });
    } catch (e: any) {
        return c.json({ success: false, error: e.message });
    }
});

app.get('/:filename', async (c) => {
    return handleRequest(c, c.req.param("filename"), "GET");
});

app.on('HEAD', '/:filename', async (c) => {
    return handleRequest(c, c.req.param("filename"), "HEAD");
})

async function handleRequest(c: any, filename: string, method: string) {
    if (filename === 'favicon.ico') return c.text('No Icon', 404);
    
    try {
        const fileData = await kv.get(`media:${filename}`) as any;
        if (!fileData) return c.text("File Not Found", 404);

        let finalStreamUrl = null;

        if (fileData.type === "mediafire") {
            const cacheKey = `cache:${filename}`;
            const cachedLink = await kv.get(cacheKey) as string;
            if (cachedLink) {
                finalStreamUrl = cachedLink;
            } else {
                try {
                    const pageRes = await fetch(fileData.url, { headers: { "User-Agent": "Mozilla/5.0" } });
                    const html = await pageRes.text();
                    let match = html.match(/aria-label="Download file"\s+href="([^"]+)"/);
                    if (!match) match = html.match(/id="downloadButton"\s+href="([^"]+)"/);
                    if (match && match[1]) {
                        finalStreamUrl = match[1];
                        await kv.set(cacheKey, finalStreamUrl, { ex: 10800 }); 
                    } else {
                        return c.text("MediaFire Blocked/Removed", 404);
                    }
                } catch (e) {
                    return c.text("Scraping Error", 502);
                }
            }
        } else {
            finalStreamUrl = fileData.url;
        }

        const rangeHeader = c.req.header("range");
        const fetchHeaders = new Headers({ "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" });
        if (rangeHeader) fetchHeaders.set("Range", rangeHeader);

        const fileRes = await fetch(finalStreamUrl, { method: method, headers: fetchHeaders });
        const newHeaders = new Headers();
        ["content-type", "content-length", "content-range", "accept-ranges", "last-modified", "etag"].forEach(h => {
            const val = fileRes.headers.get(h);
            if (val) newHeaders.set(h, val);
        });
        newHeaders.set("Content-Disposition", `attachment; filename="${filename}"`);
        newHeaders.set("Access-Control-Allow-Origin", "*");
        newHeaders.set("Accept-Ranges", "bytes");

        if (method === "HEAD") return new Response(null, { status: 200, headers: newHeaders });
        return new Response(fileRes.body, { status: fileRes.status, headers: newHeaders });

    } catch (e: any) {
        return c.text("System Error: " + e.message, 500);
    }
}

function renderLogin(e=false){return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Login</title><script src="https://cdn.tailwindcss.com"></script></head><body class="bg-black text-white min-h-screen flex items-center justify-center"><div class="max-w-sm w-full bg-gray-900 p-8 rounded-xl border border-gray-800 text-center"><h2 class="text-xl font-bold mb-4">Admin Access</h2>${e?'<p class="text-red-500 text-sm mb-4">Wrong Password!</p>':''}<form action="/login" method="POST" class="space-y-4"><input type="password" name="password" placeholder="Pass" class="w-full bg-black border border-gray-700 rounded px-4 py-2" required/><button class="w-full bg-white text-black font-bold py-2 rounded">Login</button></form></div></body></html>`;}

function renderApp() { return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Proxy Gen</title><script src="https://cdn.tailwindcss.com"></script></head><body class="bg-black text-white min-h-screen flex items-center justify-center p-4"><div class="w-full max-w-lg bg-gray-900 p-8 rounded-2xl border border-gray-800"><h1 class="text-2xl font-bold text-center mb-6">⚡ Proxy Gen</h1><div class="space-y-4"><input id="mf-link" type="text" placeholder="MediaFire / Direct URL" class="w-full bg-black border border-gray-700 rounded-lg px-4 py-2 text-white"/><input id="file-name" type="text" placeholder="Filename" class="w-full bg-black border border-gray-700 rounded-lg px-4 py-2 text-white"/><button onclick="saveLink()" id="btn" class="w-full bg-white text-black font-bold py-2 rounded-lg hover:bg-gray-200">Generate</button></div><div id="result" class="mt-6 hidden"><input id="final-link" readonly class="w-full bg-black border border-green-900 text-green-500 rounded px-2 py-1 text-sm mb-2"/><a id="test-btn" href="#" class="text-xs text-gray-400 underline">Test Download</a></div></div><script>async function saveLink(){const url=document.getElementById('mf-link').value;const name=document.getElementById('file-name').value;const btn=document.getElementById('btn');if(!url||!name)return alert("Fill all fields");btn.innerText="Processing...";btn.disabled=true;try{const res=await fetch("/create",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:new URLSearchParams({url,name})});const data=await res.json();if(data.success){document.getElementById('final-link').value=data.link;document.getElementById('test-btn').href=data.link;document.getElementById('result').classList.remove('hidden')}else{alert("ERROR: "+data.error)}}catch(e){alert("NETWORK ERROR: "+e.message)}btn.innerText="Generate";btn.disabled=false}</script></body></html>`;}

export const GET = handle(app)
export const POST = handle(app)
