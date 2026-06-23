/**
 * IOL Cards — Cloudflare Worker
 * GET /all|news|sport|... → IOL RSS feeds as JSON
 * GET /shorten?url=       → TinyURL shortener
 * GET /image?url=         → CORS image proxy
 * POST /claude            → Anthropic API proxy (ANTHROPIC_KEY secret)
 */
const CORS = {'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,POST,OPTIONS','Access-Control-Allow-Headers':'Content-Type'};
const SECTIONS = ['news','sport','business','entertainment','technology','motoring','lifestyle'];
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
      const imgUrl = url.searchParams.get('url');
      if (!imgUrl) return new Response('Missing ?url=',{status:400,headers:CORS});
      try {
        const res = await fetch(imgUrl,{headers:{'User-Agent':'Mozilla/5.0 (compatible; Googlebot/2.1)','Referer':'https://www.iol.co.za/'},cf:{cacheTtl:3600,cacheEverything:true}});
        if (!res.ok) return new Response('Failed:'+res.status,{status:res.status,headers:CORS});
        const ct = res.headers.get('content-type')||'image/jpeg';
        return new Response(await res.arrayBuffer(),{status:200,headers:{...CORS,'Content-Type':ct,'Cache-Control':'public,max-age=3600'}});
      } catch(e){return new Response('Error:'+e.message,{status:500,headers:CORS});}
    }

    if (path === 'shorten') {
      const longUrl = url.searchParams.get('url');
      if (!longUrl) return j({ok:false,error:'Missing ?url='},400);
      try {
        const r = await fetch('https://tinyurl.com/api-create.php?url='+encodeURIComponent(longUrl));
        const s = (await r.text()).trim();
        if (!s.startsWith('http')) throw new Error('Bad response');
        return j({ok:true,short:s,long:longUrl});
      } catch(e){return j({ok:false,error:e.message,fallback:longUrl});}
    }

    try {
      if (path === 'all') {
        const results = await Promise.allSettled(SECTIONS.map(s=>fetchSection(s)));
        const stories = results.flatMap(r=>r.status==='fulfilled'?r.value:[]);
        const seen = new Set();
        const unique = stories.filter(s=>{const k=s.headline.toLowerCase().slice(0,60);if(seen.has(k))return false;seen.add(k);return true;});
        return j({ok:true,count:unique.length,stories:unique});
      }
      if (!SECTIONS.includes(path)) return j({ok:false,error:'Unknown: '+path},400);
      const stories = await fetchSection(path);
      return j({ok:true,count:stories.length,section:path,stories});
    } catch(e){return j({ok:false,error:e.message},500);}
  }
};

async function fetchSection(section) {
  const res = await fetch('https://iol.co.za/rss/extended/iol/'+section+'/',{headers:{'User-Agent':'Mozilla/5.0 (compatible; IOL Cards/1.0)','Accept':'application/rss+xml,text/xml'},cf:{cacheTtl:300,cacheEverything:true}});
  if (!res.ok) throw new Error('Feed '+res.status);
  return parseRSS(await res.text(), section, LABELS[section]||'IOL');
}

function parseRSS(xml, section, src) {
  const stories=[], re=/<item>([\s\S]*?)<\/item>/g; let m;
  while((m=re.exec(xml))!==null){
    const item=m[1];
    const title=cdata(item,'title'), link=tag(item,'link')||tag(item,'guid');
    const desc=cdata(item,'description'), author=cdata(item,'author')||src, pub=tag(item,'pubDate')||'';
    const imgM=item.match(/<media:content[\s\S]*?url="([^"]+)"/i)||item.match(/<media:thumbnail[\s\S]*?url="([^"]+)"/i);
    if(!title||title.length<5)continue;
    let cat=section;
    if(link){if(/\/politics\//.test(link))cat='politics';else if(/\/sport\//.test(link))cat='sport';else if(/\/business\//.test(link))cat='business';else if(/\/crime/.test(link))cat='news';else if(/\/motoring\//.test(link))cat='motoring';else if(/\/lifestyle\//.test(link))cat='lifestyle';else if(/\/technology\//.test(link))cat='technology';else if(/\/entertainment\//.test(link))cat='entertainment';}
    stories.push({headline:strip(title).trim(),excerpt:strip(desc||'').replace(/\s+/g,' ').trim().slice(0,220),category:cat,source:strip(author).trim().slice(0,50)||src,pubDate:pub,url:link?link.trim():'https://www.iol.co.za/'+section+'/',image:imgM?imgM[1]:''});
  }
  return stories;
}
function cdata(x,t){const r=new RegExp('<'+t+'[^>]*>(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([\\s\\S]*?))<\\/'+t+'>','i'),m=x.match(r);return m?(m[1]!==undefined?m[1]:m[2]||'').trim():'';}
function tag(x,t){const r=new RegExp('<'+t+'[^>]*>([\\s\\S]*?)<\\/'+t+'>','i'),m=x.match(r);return m?m[1].trim():'';}
function strip(h){return h.replace(/<[^>]+>/g,' ').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#039;/g,"'").replace(/&nbsp;/g,' ').replace(/\s+/g,' ').trim();}
function j(data,status=200){return new Response(JSON.stringify(data),{status,headers:{...CORS,'Content-Type':'application/json'}});}
