const express=require('express'),Database=require('better-sqlite3'),{XMLParser}=require('fast-xml-parser'),cheerio=require('cheerio'),rateLimit=require('express-rate-limit'),dns=require('dns').promises,crypto=require('crypto');
const PORT=process.env.PORT||3000,BATCH=+process.env.BATCH||200,SYNC_MIN=+process.env.SYNC_MINUTES||30;
const UA='UniversalAggregatorBot/1.0 (respects robots.txt)';
const TOKEN=process.env.ADMIN_TOKEN||crypto.randomBytes(12).toString('hex');
const db=new Database(process.env.DB_PATH||'data.db');db.pragma('journal_mode=WAL');
db.exec(`CREATE TABLE IF NOT EXISTS sites(id INTEGER PRIMARY KEY,url TEXT UNIQUE,origin TEXT,name TEXT,store_full INTEGER DEFAULT 0,status TEXT DEFAULT 'pending',error TEXT,last_sync TEXT,created TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS articles(id INTEGER PRIMARY KEY,site_id INTEGER,url TEXT UNIQUE,title TEXT,description TEXT,image TEXT,author TEXT,published TEXT,category TEXT,content TEXT,created TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX IF NOT EXISTS ix1 ON articles(published DESC);CREATE INDEX IF NOT EXISTS ix2 ON articles(site_id);
CREATE TABLE IF NOT EXISTS skipped(url TEXT PRIMARY KEY);`);

// ---------- helpers ----------
const xp=new XMLParser({ignoreAttributes:false,attributeNamePrefix:'@_'});
const A=x=>x==null?[]:Array.isArray(x)?x:[x];
const T=v=>v&&typeof v==='object'?String(v['#text']??v['@_href']??''):String(v??'');
const strip=s=>cheerio.load('<div>'+(s||'')+'</div>').text().replace(/\s+/g,' ').trim();
const paras=h=>{const $=cheerio.load('<div>'+h+'</div>'),p=$('p').map((_,e)=>$(e).text().trim()).get().filter(Boolean);return(p.length?p:[$.text().trim()]).join('\n\n')};
const imgFrom=h=>(h||'').match(/<img[^>]+src=["']([^"']+)/i)?.[1]||'';
const iso=d=>{const t=new Date(d);return d&&!isNaN(t)?t.toISOString():null};
const priv=ip=>/^(10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.|::1|f[cd]|fe80)/i.test(ip);
async function safe(u){const x=new URL(u);if(!/^https?:$/.test(x.protocol))throw Error('Only http/https URLs are allowed');
  if((await dns.lookup(x.hostname,{all:true})).some(a=>priv(a.address)))throw Error('Private/internal addresses are blocked')}
async function get(u,hops=0){await safe(u);
  const r=await fetch(u,{headers:{'user-agent':UA,accept:'text/html,application/xml,*/*'},redirect:'manual',signal:AbortSignal.timeout(15000)});
  if(r.status>=300&&r.status<400&&r.headers.get('location')&&hops<4)return get(new URL(r.headers.get('location'),u).href,hops+1);
  if([401,403,429].includes(r.status))throw Error(`Site blocked access (HTTP ${r.status})`);
  if(!r.ok)throw Error('HTTP '+r.status);return(await r.text()).slice(0,5e6)}
const rc={};
async function robots(o){if(rc[o])return rc[o];const R={rules:[],maps:[]};
  try{let on=false;for(const l of(await get(o+'/robots.txt')).split(/\r?\n/)){const m=l.match(/^\s*([\w-]+)\s*:\s*([^#]*)/);if(!m)continue;const k=m[1].toLowerCase(),v=m[2].trim();
    if(k==='user-agent')on=v==='*';else if(k==='disallow'&&on&&v&&!/[*$]/.test(v))R.rules.push(v);else if(k==='sitemap')R.maps.push(v)}}catch{}
  setTimeout(()=>delete rc[o],6e5);return rc[o]=R}
const allowed=(R,u)=>!R.rules.some(r=>new URL(u).pathname.startsWith(r));

function parseFeed(xml){const d=xp.parse(xml),out=[];
  for(const i of A(d.rss?.channel?.item)){const c=T(i['content:encoded']);out.push({url:T(i.link),title:strip(T(i.title)),description:strip(T(i.description)),content:c,
    image:i['media:content']?.['@_url']||i.enclosure?.['@_url']||i['media:thumbnail']?.['@_url']||imgFrom(c||T(i.description)),author:T(i['dc:creator']||i.author),published:T(i.pubDate||i['dc:date']),category:T(A(i.category)[0])})}
  for(const e of A(d.feed?.entry)){const l=A(e.link),alt=l.find(x=>!x['@_rel']||x['@_rel']==='alternate')||l[0],c=T(e.content);
    out.push({url:alt?.['@_href']||'',title:strip(T(e.title)),description:strip(T(e.summary||e.content)),content:c,image:imgFrom(c),author:T(e.author?.name),published:T(e.published||e.updated),category:A(e.category)[0]?.['@_term']||''})}
  return out}
async function scrape(u){const $=cheerio.load(await get(u)),m=n=>$(`meta[property="${n}"],meta[name="${n}"]`).attr('content')||'';let ld={};
  $('script[type="application/ld+json"]').each((_,e)=>{try{const j=JSON.parse($(e).text());for(const o of A(j['@graph']||j))if(/Article|Posting/.test(A(o['@type']).join()))ld=o}catch{}});
  const body=$('article p,[itemprop=articleBody] p,main p').map((_,e)=>$(e).text().trim()).get().filter(x=>x.length>40).join('\n\n'),au=A(ld.author)[0];
  return{url:u,title:m('og:title')||$('title').text().trim(),description:m('og:description')||m('description'),image:m('og:image'),author:typeof au==='string'?au:au?.name||m('author'),
    published:m('article:published_time')||ld.datePublished||'',category:m('article:section'),content:body,siteName:m('og:site_name'),isArticle:m('og:type')==='article'||!!ld['@type']||body.length>400}}
const ins=db.prepare('INSERT OR IGNORE INTO articles(site_id,url,title,description,image,author,published,category,content) VALUES(?,?,?,?,?,?,?,?,?)');
const save=(s,a)=>{if(!a.url||!a.title)return 0;const full=s.store_full&&a.content?paras(a.content):null;
  return ins.run(s.id,a.url.split('#')[0],a.title.trim(),(a.description||strip(a.content)).slice(0,500),a.image||'',a.author||'',iso(a.published),a.category||'',full).changes};

// ---------- sync ----------
async function sync(id){const s=db.prepare('SELECT * FROM sites WHERE id=?').get(id);if(!s)return;
  db.prepare("UPDATE sites SET status='syncing' WHERE id=?").run(id);const notes=[];let remaining=0,found=false;
  try{const R=await robots(s.origin),have=new Set([...db.prepare('SELECT url FROM articles WHERE site_id=?').all(id).map(r=>r.url),...db.prepare("SELECT url FROM skipped WHERE url LIKE ?").all(s.origin+'%').map(r=>r.url)]);
    const feeds=new Set(),maps=new Set(R.maps);
    try{const h=cheerio.load(await get(s.url));h('link[rel=alternate]').each((_,e)=>{if(/rss|atom/.test(h(e).attr('type')||''))feeds.add(new URL(h(e).attr('href'),s.url).href)});
      if(!s.name||s.name===s.origin){const n=h('meta[property="og:site_name"]').attr('content')||h('title').text().trim();if(n)db.prepare('UPDATE sites SET name=? WHERE id=?').run(n.slice(0,80),id)}}
    catch(e){notes.push('Homepage: '+e.message)}
    if(!feeds.size)['/feed','/rss','/rss.xml','/feed.xml','/atom.xml'].forEach(p=>feeds.add(s.origin+p));
    if(!maps.size)['/sitemap.xml','/sitemap_index.xml','/wp-sitemap.xml'].forEach(p=>maps.add(s.origin+p));
    for(const f of feeds){let ok=false;try{for(let p=1;p<=100;p++){const u=p>1?f+(f.includes('?')?'&':'?')+'paged='+p:f;let items;
      try{items=parseFeed(await get(u))}catch(e){if(p===1)throw e;break}if(!items.length)break;ok=found=true;let fresh=0;
      for(const a of items)if(a.url&&!have.has(a.url)&&allowed(R,a.url)){fresh++;save(s,a);have.add(a.url)}if(p>1&&!fresh)break}}catch(e){if(feeds.size<=1||ok)notes.push('Feed '+f+': '+e.message)}}
    const urls=new Map(),seen=new Set();
    const walk=async(u,d)=>{if(seen.has(u)||seen.size>60||d>3||/\.gz$/i.test(u))return;seen.add(u);let x;try{x=xp.parse(await get(u))}catch(e){if(R.maps.includes(u))notes.push('Sitemap '+u+': '+e.message);return}
      for(const m of A(x.sitemapindex?.sitemap))await walk(T(m.loc),d+1);for(const m of A(x.urlset?.url)){const l=T(m.loc);if(/^https?:/.test(l))urls.set(l,T(m.lastmod))}};
    for(const m of maps)await walk(m,0);if(urls.size)found=true;
    const host=new URL(s.origin).hostname.replace(/^www\./,''),
    cand=[...urls.keys()].filter(u=>{const x=new URL(u);return!have.has(u)&&x.hostname.replace(/^www\./,'')===host&&x.pathname.length>1&&!/\.(jpe?g|png|gif|webp|pdf|mp4|svg)$/i.test(x.pathname)&&!/\/(tags?|categor(y|ies)|author|page|search)\//i.test(x.pathname)&&allowed(R,u)})
      .sort((a,b)=>(urls.get(b)||'').localeCompare(urls.get(a)||''));
    const todo=cand.slice(0,BATCH);remaining=cand.length-todo.length;let i=0;const skip=db.prepare('INSERT OR IGNORE INTO skipped(url) VALUES(?)');
    await Promise.all([0,1,2,3].map(async()=>{while(i<todo.length){const u=todo[i++];try{const a=await scrape(u);if(a.isArticle)save(s,a);else skip.run(u)}catch{skip.run(u)}}}));
    const total=db.prepare('SELECT COUNT(*) c FROM articles WHERE site_id=?').get(id).c;
    let err=notes.join('; ').slice(0,600)||null;if(!total&&!found)err='No accessible RSS/Atom feed or sitemap was found (the site may not publish one, or it blocks bots). '+(err||'');
    else if(!total)err='Sources were found but no articles could be extracted (blocked by robots.txt, paywall or scripts). '+(err||'');
    db.prepare('UPDATE sites SET status=?,error=?,last_sync=? WHERE id=?').run(total?(remaining?'syncing':'ok'):'error',err,new Date().toISOString(),id);
  }catch(e){db.prepare("UPDATE sites SET status='error',error=?,last_sync=? WHERE id=?").run(e.message,new Date().toISOString(),id)}
  if(remaining>0)queue(id)}
const q=[];let run=0;
function queue(id){if(!q.includes(id))q.push(id);pump()}
function pump(){while(run<2&&q.length){run++;sync(q.shift()).catch(()=>{}).finally(()=>{run--;pump()})}}

// ---------- API ----------
const app=express();app.use(express.json());app.use(rateLimit({windowMs:6e4,limit:300}));
app.use((req,res,n)=>{if(process.env.CORS_ORIGIN){res.set('Access-Control-Allow-Origin',process.env.CORS_ORIGIN);res.set('Access-Control-Allow-Headers','content-type,x-admin-token');res.set('Access-Control-Allow-Methods','GET,POST,PATCH,DELETE')}n()});
const adm=(req,res,n)=>req.get('x-admin-token')===TOKEN?n():res.status(401).json({error:'Invalid or missing admin token'});
app.get('/api/admin/check',adm,(_,r)=>r.json({ok:true}));
app.get('/api/sites',(_,r)=>r.json(db.prepare('SELECT s.*,(SELECT COUNT(*) FROM articles WHERE site_id=s.id) count FROM sites s ORDER BY name').all()));
app.get('/api/categories',(_,r)=>r.json(db.prepare("SELECT category,COUNT(*) n FROM articles WHERE category!='' GROUP BY category ORDER BY n DESC LIMIT 200").all().map(x=>x.category)));
app.get('/api/articles',(req,res)=>{const{q:s,site,category,from,to}=req.query,w=[],p=[];
  for(const t of String(s||'').split(/\s+/).filter(Boolean)){w.push('(a.title LIKE ? OR a.description LIKE ? OR a.content LIKE ? OR s.name LIKE ? OR a.category LIKE ?)');p.push(...Array(5).fill('%'+t+'%'))}
  if(site){w.push('a.site_id=?');p.push(site)}if(category){w.push('a.category=?');p.push(category)}if(from){w.push('a.published>=?');p.push(from)}if(to){w.push('a.published<=?');p.push(to+'T23:59:59Z')}
  const page=Math.max(1,+req.query.page||1),lim=Math.min(48,+req.query.limit||24),base=`FROM articles a JOIN sites s ON s.id=a.site_id ${w.length?'WHERE '+w.join(' AND '):''}`;
  const total=db.prepare('SELECT COUNT(*) c '+base).get(...p).c;
  res.json({total,page,pages:Math.ceil(total/lim),items:db.prepare(`SELECT a.id,a.title,a.description,a.image,a.author,a.published,a.category,a.url,s.name source ${base} ORDER BY COALESCE(a.published,a.created) DESC LIMIT ? OFFSET ?`).all(...p,lim,(page-1)*lim)})});
app.get('/api/articles/:id',(req,res)=>{const a=db.prepare('SELECT a.*,s.name source,s.origin FROM articles a JOIN sites s ON s.id=a.site_id WHERE a.id=?').get(req.params.id);a?res.json(a):res.status(404).json({error:'Article not found'})});
app.post('/api/sites',adm,async(req,res)=>{try{let u=String(req.body.url||'').trim();if(!/^https?:\/\//i.test(u))u='https://'+u;const x=new URL(u);await safe(x.href);
  const r=db.prepare('INSERT INTO sites(url,origin,name) VALUES(?,?,?)').run(x.origin,x.origin,x.hostname);queue(r.lastInsertRowid);res.json({id:r.lastInsertRowid})}
  catch(e){res.status(400).json({error:/UNIQUE/.test(e.message)?'This website is already added':e.message})}});
app.post('/api/sites/:id/sync',adm,(req,res)=>{queue(+req.params.id);res.json({queued:true})});
app.patch('/api/sites/:id',adm,(req,res)=>{db.prepare('UPDATE sites SET store_full=? WHERE id=?').run(req.body.store_full?1:0,req.params.id);res.json({ok:true})});
app.delete('/api/sites/:id',adm,(req,res)=>{db.prepare('DELETE FROM articles WHERE site_id=?').run(req.params.id);db.prepare('DELETE FROM sites WHERE id=?').run(req.params.id);res.json({ok:true})});
app.patch('/api/articles/:id',adm,(req,res)=>{db.prepare('UPDATE articles SET category=? WHERE id=?').run(String(req.body.category||'').slice(0,60),req.params.id);res.json({ok:true})});
app.delete('/api/articles/:id',adm,(req,res)=>{const a=db.prepare('SELECT url FROM articles WHERE id=?').get(req.params.id);if(a)db.prepare('INSERT OR IGNORE INTO skipped(url) VALUES(?)').run(a.url);db.prepare('DELETE FROM articles WHERE id=?').run(req.params.id);res.json({ok:true})});
app.use(express.static(__dirname+'/public'));
app.listen(PORT,()=>{console.log(`Running at http://localhost:${PORT}\nAdmin token: ${TOKEN}${process.env.ADMIN_TOKEN?' (from env)':' (random; set ADMIN_TOKEN to keep it stable)'}`);
  db.prepare("UPDATE sites SET status='pending' WHERE status='syncing'").run();db.prepare("SELECT id FROM sites").all().forEach(x=>queue(x.id));
  setInterval(()=>db.prepare('SELECT id FROM sites').all().forEach(x=>queue(x.id)),SYNC_MIN*6e4)});
