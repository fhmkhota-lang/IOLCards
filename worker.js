/**
 * IOL Cards — Cloudflare Worker
 * GET /all|news|sport|... → IOL RSS feeds as JSON
 * GET /shorten?url=       → is.gd / v.gd shortener (no key); falls back to real URL
 * GET /image?url=         → CORS image proxy
 * POST /claude            → Anthropic API proxy (ANTHROPIC_KEY secret)
 */
const CORS = {'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,POST,OPTIONS','Access-Control-Allow-Headers':'Content-Type'};
const SECTIONS = ['news','sport','business','entertainment','technology','motoring','lifestyle','travel'];
// Extra sub-feeds merged into a section to deepen the pool (more Load More).
// Kept conservative: only paths confirmed to exist. Politics folds into News.
const SUBFEEDS = {
  news: ['news','politics'],
};
const LABELS = {news:'IOL News',sport:'IOL Sport',business:'Business Report',entertainment:'Tonight',technology:'IOL Tech',motoring:'IOL Motoring',lifestyle:'IOL Lifestyle'};

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, {headers:CORS});
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\//,'').toLowerCase().trim();

    if (path === 'claude' && request.method === 'POST') {
      const key = env.ANTHROPIC_KEY;
      if (!key) return j({error:'ANTHROPIC_KEY not set in Worker secrets'},500);
      try {
        const body = await request.json();
        const res = await fetch('https://api.anthropic.com/v1/messages',{method:'POST',headers:{'Content-Type':'application/json','x-api-key':key,'anthropic-version':'2023-06-01'},body:JSON.stringify(body)});
        const data = await res.json();
        return new Response(JSON.stringify(data),{status:res.status,headers:{...CORS,'Content-Type':'application/json'}});
      } catch(e){return j({error:e.message},500);}
    }

    if (path === 'image') {
      let imgUrl = url.searchParams.get('url');
      if (!imgUrl) return new Response('Missing ?url=',{status:400,headers:CORS});
      // For iol-prod.appspot.com, strip any size limits and request 1200px wide
      if (imgUrl.includes('iol-prod.appspot.com') || imgUrl.includes('iol.co.za')) {
        try {
          const u = new URL(imgUrl);
          // Clear all existing image transform params
          ['impolicy','wid','hei','fit','op_usm','qlt','fmt'].forEach(p => u.searchParams.delete(p));
          // Request full width — IOL's CDN serves up to 1200px
          u.searchParams.set('wid', '1200');
          imgUrl = u.toString();
        } catch(e) { /* malformed URL, use as-is */ }
      }
      try {
        const res = await fetch(imgUrl,{headers:{'User-Agent':'Mozilla/5.0 (compatible; Googlebot/2.1)','Referer':'https://www.iol.co.za/'},cf:{cacheTtl:3600,cacheEverything:true}});
        if (!res.ok) return new Response('Failed:'+res.status,{status:res.status,headers:CORS});
        const ct = res.headers.get('content-type')||'image/jpeg';
        return new Response(await res.arrayBuffer(),{status:200,headers:{...CORS,'Content-Type':ct,'Cache-Control':'public,max-age=3600'}});
      } catch(e){return new Response('Error:'+e.message,{status:500,headers:CORS});}
    }

    if (path === 'fullimage') {
      const articleUrl = url.searchParams.get('url');
      if (!articleUrl) return j({ok:false,error:'Missing ?url='},400);
      try {
        const res = await fetch(articleUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
            'Accept-Language': 'en-ZA,en;q=0.9',
            'Referer': 'https://www.iol.co.za/',
            'Cache-Control': 'no-cache',
          },
          cf: { cacheTtl: 1800, cacheEverything: true }
        });
        if (!res.ok) return j({ok:false, error:'HTTP '+res.status}, 502);
        const html = await res.text();
        let imgUrl = '';
        // og:image (highest quality, usually 1200px+)
        const ogImg = html.match(/<meta[^>]*property=["']og:image["'][^>]*content=["']([^"']+)["']/i)
                   || html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*property=["']og:image["']/i);
        if (ogImg) imgUrl = ogImg[1];
        // twitter:image fallback
        if (!imgUrl) {
          const twImg = html.match(/<meta[^>]*name=["']twitter:image["'][^>]*content=["']([^"']+)["']/i)
                     || html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*name=["']twitter:image["']/i);
          if (twImg) imgUrl = twImg[1];
        }
        // iol-prod.appspot.com image in HTML
        if (!imgUrl) {
          const srcMatch = html.match(/https?:\/\/iol-prod\.appspot\.com\/[^"'\s>]+/i);
          if (srcMatch) imgUrl = srcMatch[0];
        }
        if (imgUrl) {
          if (imgUrl.startsWith('//')) imgUrl = 'https:' + imgUrl;
          try {
            const u = new URL(imgUrl);
            ['impolicy','wid','hei','fit','op_usm','qlt','fmt','$staticlink$'].forEach(p => u.searchParams.delete(p));
            u.searchParams.set('wid', '1200');
            return j({ok:true, url: u.toString()});
          } catch(e) {
            return j({ok:true, url: imgUrl});
          }
        }
        return j({ok:false, error:'No og:image found'}, 404);
      } catch(e) {
        return j({ok:false, error: String(e.message)}, 500);
      }
    }

    if (path === 'shorten') {
      const longUrl = url.searchParams.get('url');
      if (!longUrl) return j({ok:false,error:'Missing ?url='},400);
      const enc = encodeURIComponent(longUrl);
      const UA = 'Mozilla/5.0 (compatible; IOL Cards Studio/1.0)';
      const errors = [];
      // is.gd and v.gd only (same trusted operator, separate hosts/limits).
      // Both point straight at the real URL. If both fail we return the full
      // real link — never a third party that could rewrite the destination.
      const providers = [
        { name:'is.gd', url:'https://is.gd/create.php?format=simple&url='+enc },
        { name:'v.gd',  url:'https://v.gd/create.php?format=simple&url='+enc },
      ];
      for (const p of providers) {
        try {
          const r = await fetch(p.url, { headers: { 'User-Agent': UA } });
          const s = (await r.text()).trim();
          if (r.ok && s.startsWith('http')) return j({ok:true,short:s,long:longUrl,via:p.name});
          errors.push(p.name+': '+(s || ('HTTP '+r.status)));
        } catch(e){ errors.push(p.name+': '+e.message); }
      }
      return j({ok:false,error:errors.join(' | '),fallback:longUrl});
    }

    try {
      if (path === 'all') {
        const results = await Promise.allSettled(SECTIONS.map(s=>fetchSection(s)));
        const stories = results.flatMap(r=>r.status==='fulfilled'?r.value:[]);
        const seen = new Set();
        const unique = stories.filter(s=>{const k=s.headline.toLowerCase().slice(0,60);if(seen.has(k))return false;seen.add(k);return true;});
        if (url.searchParams.get('debug')) {
          const dbg = {};
          SECTIONS.forEach((s,i)=>{const r=results[i];dbg[s]=r.status==='fulfilled'?r.value.length:('ERR: '+(r.reason&&r.reason.message||r.reason));});
          return j({ok:true,count:unique.length,perSection:dbg,stories:unique});
        }
        return j({ok:true,count:unique.length,stories:unique});
      }
      if (!SECTIONS.includes(path)) return j({ok:false,error:'Unknown: '+path},400);
      const stories = await fetchSection(path);
      return j({ok:true,count:stories.length,section:path,stories});
    } catch(e){return j({ok:false,error:e.message},500);}
  }
};

async function fetchSection(section) {
  // Primary feed = the section's own feed. Always fetch it first.
  let primary = [];
  try { primary = await fetchFeed(section, section); } catch(e){ primary = []; }

  // Optional extra sub-feeds that only ADD to the pool. Their failure or
  // emptiness must never reduce the primary result.
  const extras = (SUBFEEDS[section] || []).filter(sl => sl !== section);
  if (extras.length) {
    const results = await Promise.allSettled(extras.map(sl => fetchFeed(sl, section)));
    for (const r of results) if (r.status === 'fulfilled') primary = primary.concat(r.value);
  }

  // Dedupe by headline
  const seen = new Set();
  return primary.filter(s => {
    const k = (s.headline||'').toLowerCase().slice(0,60);
    if (!k || seen.has(k)) return false; seen.add(k); return true;
  });
}

// Fetch a single feed slug, trying a few host/path variants. `tagAs` is the
// fallback category used when a story's URL doesn't reveal its own section.
async function fetchFeed(slug, tagAs) {
  const HDRS = {'User-Agent':'Mozilla/5.0 (compatible; IOL Cards/1.0)','Accept':'application/rss+xml,text/xml'};
  const paths = [
    'https://iol.co.za/rss/extended/iol/'+slug+'/',
    'https://iol.co.za/rss/iol/'+slug,
    'https://rss.iol.io/iol/'+slug,
  ];
  let lastErr = null;
  for (const u of paths) {
    try {
      const res = await fetch(u, {headers:HDRS, cf:{cacheTtl:60}});
      if (!res.ok) { lastErr = new Error('Feed '+res.status); continue; }
      const stories = parseRSS(await res.text(), tagAs, LABELS[tagAs]||'IOL');
      if (stories.length) return stories;
    } catch(e) { lastErr = e; }
  }
  if (lastErr) throw lastErr;
  return [];
}

function parseRSS(xml, section, src) {
  const stories=[], re=/<item>([\s\S]*?)<\/item>/g; let m;
  while((m=re.exec(xml))!==null){
    const item=m[1];
    const title=cdata(item,'title'), link=tag(item,'link')||tag(item,'guid');
    const desc=cdata(item,'description'), author=cdata(item,'author')||src, pub=tag(item,'pubDate')||'';
    // Try enclosure first (often higher res), fall back to media:content / media:thumbnail
    const encM=item.match(/<enclosure[^>]*url="([^"]+)"/i);
    const mediaM=item.match(/<media:content[\s\S]*?url="([^"]+)"/i)||item.match(/<media:thumbnail[\s\S]*?url="([^"]+)"/i);
    const imgM = encM || mediaM;
    if(!title||title.length<5)continue;
    let cat=section;
    if(link){if(/\/politics\//.test(link))cat='politics';else if(/\/sport\//.test(link))cat='sport';else if(/\/business\//.test(link))cat='business';else if(/\/crime/.test(link))cat='news';else if(/\/motoring\//.test(link))cat='motoring';else if(/\/travel\//.test(link))cat='travel';else if(/\/lifestyle\//.test(link))cat='lifestyle';else if(/\/technology\//.test(link))cat='technology';else if(/\/entertainment\//.test(link))cat='entertainment';}
    const kicker = (() => {
      const sectionLabels = {
        'news':'News','politics':'Politics','sport':'Sport','business':'Business',
        'technology':'Technology','motoring':'Motoring','travel':'Travel',
        'entertainment':'Lifestyle','lifestyle':'Lifestyle','leisure':'Leisure'
      };
      return sectionLabels[cat] || sectionLabels[section] || src || 'IOL';
    })();
    stories.push({headline:strip(title).trim(),excerpt:strip(desc||'').replace(/\s+/g,' ').trim().slice(0,220),category:cat,kicker,source:strip(author).trim().slice(0,50)||src,pubDate:pub,url:link?link.trim():'https://www.iol.co.za/'+section+'/',image:imgM?imgM[1]:''});
  }
  return stories;
}
function cdata(x,t){const r=new RegExp('<'+t+'[^>]*>(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([\\s\\S]*?))<\\/'+t+'>','i'),m=x.match(r);return m?(m[1]!==undefined?m[1]:m[2]||'').trim():'';}
function tag(x,t){const r=new RegExp('<'+t+'[^>]*>([\\s\\S]*?)<\\/'+t+'>','i'),m=x.match(r);return m?m[1].trim():'';}
function strip(h){return h.replace(/<[^>]+>/g,' ').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#039;/g,"'").replace(/&nbsp;/g,' ').replace(/\s+/g,' ').trim();}
function j(data,status=200){return new Response(JSON.stringify(data),{status,headers:{...CORS,'Content-Type':'application/json','Cache-Control':'no-store, max-age=0'}});}
