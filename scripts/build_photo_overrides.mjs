import fs from 'node:fs/promises';

const MASTER='data/player_status.csv';
const PHOTO_INDEX='data/afl_photo_index.json';
const OUTPUT='data/photo_overrides.json';

const STAR_NAMES=new Set([
'Nick Daicos','Harry Sheezel','Harley Reid','Nick Watson','Sam Darcy',
'Jason Horne-Francis','Logan Morris','Josh Treacy','Kysaiah Pickett',
'Nasiah Wanganeen-Milera','Zak Butters','Connor Rozee','Will Day',
'Bailey Smith','Finn Callaghan','Tom Green','Errol Gulden','Chad Warner',
'Izak Rankine','Noah Anderson','Matt Rowell','Max Holmes','Jye Amiss',
'Luke Jackson','Josh Rachele','Riley Thilthorpe','Colby McKercher',
'George Wardlaw','Cam Mackenzie','Jai Newcombe','Josh Weddle',
'Mabior Chol','Dylan Moore','Jarman Impey','Josh Battle',
'Jordan Clark','Lachie Ash','Oliver Dempsey','Murphy Reid'
]);

function csvCells(line){
  const out=[];let cur='',q=false;
  for(let i=0;i<line.length;i++){
    const ch=line[i];
    if(ch==='"'){
      if(q&&line[i+1]==='"'){cur+='"';i++}
      else q=!q;
    }else if(ch===','&&!q){out.push(cur);cur=''}
    else cur+=ch;
  }
  out.push(cur);
  return out;
}
const norm=s=>String(s||'').toLowerCase().replace(/[^a-z0-9]/g,'');
const title=s=>String(s||'').split(/([-'])/).map(p=>p==='-'||p==="'"?p:(p?p[0].toUpperCase()+p.slice(1):p)).join('');
const identity=(name,dob)=>norm(name)+'|'+String(dob||'');

function dobFromKey(key){
  const m=String(key||'').match(/^(\d{2})(\d{2})(\d{4})$/);
  return m?{day:+m[1],month:+m[2],year:+m[3]}:null;
}
function birthMatches(time,dobKey){
  if(!time||!dobKey)return true;
  const wanted=dobFromKey(dobKey);
  const m=String(time).match(/^[+-](\d{4})-(\d{2})-(\d{2})/);
  if(!wanted||!m)return false;
  return +m[1]===wanted.year && +m[2]===wanted.month && +m[3]===wanted.day;
}
function nameMatch(label,name){
  if(norm(label)===norm(name))return true;
  const a=String(label||'').trim().split(/\s+/);
  const b=String(name||'').trim().split(/\s+/);
  if(a.length<2||b.length<2)return false;
  const af=norm(a[0]),bf=norm(b[0]);
  const al=norm(a[a.length-1]),bl=norm(b[b.length-1]);
  return al===bl && !!af && !!bf && (af===bf||af.startsWith(bf)||bf.startsWith(af));
}

async function fetchTimeout(url,options={},ms=8000){
  const c=new AbortController();
  const t=setTimeout(()=>c.abort(),ms);
  try{return await fetch(url,{...options,signal:c.signal,headers:{'user-agent':'AFL-Guess-Who-photo-validator/1.0',...(options.headers||{})}})}
  finally{clearTimeout(t)}
}
async function imageWorks(url){
  if(!url)return false;
  try{
    const r=await fetchTimeout(url,{redirect:'follow'},6500);
    if(!r.ok)return false;
    const type=(r.headers.get('content-type')||'').toLowerCase();
    if(type.startsWith('image/'))return true;
    const b=await r.arrayBuffer();
    return b.byteLength>1500;
  }catch{return false}
}
async function json(url){
  const r=await fetchTimeout(url,{},8000);
  if(!r.ok)throw new Error('HTTP '+r.status+' '+url);
  return r.json();
}
async function commonsFileUrl(file){
  const u='https://commons.wikimedia.org/w/api.php?action=query&format=json&origin=*&titles='+encodeURIComponent('File:'+file)+'&prop=imageinfo&iiprop=url&iiurlwidth=800';
  try{
    const j=await json(u);
    const p=Object.values(j.query?.pages||{})[0];
    return p?.imageinfo?.[0]?.thumburl||p?.imageinfo?.[0]?.url||'';
  }catch{return ''}
}

async function wikidataPhoto(name,dobKey){
  const q=encodeURIComponent(name+' Australian rules footballer');
  let j;
  try{
    j=await json('https://www.wikidata.org/w/api.php?action=wbsearchentities&format=json&origin=*&language=en&limit=8&search='+q);
  }catch{return ''}
  const candidates=(j.search||[]).filter(x=>nameMatch(x.label,name)&&/australian|football|afl|sport/i.test(x.description||''));
  for(const c of candidates){
    try{
      const e=await json('https://www.wikidata.org/w/api.php?action=wbgetentities&format=json&origin=*&ids='+encodeURIComponent(c.id)+'&props=claims');
      const claims=e.entities?.[c.id]?.claims||{};
      const born=claims.P569?.[0]?.mainsnak?.datavalue?.value?.time;
      if(born&&!birthMatches(born,dobKey))continue;
      const file=claims.P18?.[0]?.mainsnak?.datavalue?.value;
      if(file){
        const url=await commonsFileUrl(file);
        if(url&&await imageWorks(url))return url;
      }
    }catch{}
  }
  return '';
}

async function wikipediaPhoto(name,dobKey){
  const q=encodeURIComponent('"'+name+'" "Australian rules footballer"');
  try{
    const s=await json('https://en.wikipedia.org/w/api.php?action=query&format=json&origin=*&generator=search&gsrsearch='+q+'&gsrlimit=8&prop=pageprops|pageimages&piprop=thumbnail&pithumbsize=800');
    const pages=Object.values(s.query?.pages||{}).filter(p=>nameMatch(p.title,name));
    for(const p of pages){
      const item=p.pageprops?.wikibase_item;
      if(item){
        const e=await json('https://www.wikidata.org/w/api.php?action=wbgetentities&format=json&origin=*&ids='+encodeURIComponent(item)+'&props=claims');
        const born=e.entities?.[item]?.claims?.P569?.[0]?.mainsnak?.datavalue?.value?.time;
        if(born&&!birthMatches(born,dobKey))continue;
      }
      const url=p.thumbnail?.source||'';
      if(url&&await imageWorks(url))return url;
    }
  }catch{}
  return '';
}

async function verifiedBackup(name,dobKey){
  let u=await wikidataPhoto(name,dobKey);
  if(u)return {url:u,source:'Wikimedia/Wikidata'};
  u=await wikipediaPhoto(name,dobKey);
  if(u)return {url:u,source:'Wikipedia/Wikimedia'};
  return null;
}

const masterText=await fs.readFile(MASTER,'utf8');
const index=JSON.parse(await fs.readFile(PHOTO_INDEX,'utf8'));
const lines=masterText.trim().split(/\r?\n/);
const head=csvCells(lines[0]);
const ix=Object.fromEntries(head.map((h,i)=>[h,i]));
const pool=[];

for(let i=1;i<lines.length;i++){
  if(!lines[i].trim())continue;
  const v=csvCells(lines[i]);
  const name=(title(v[ix.first_name])+' '+title(v[ix.last_name])).trim();
  const lastYear=Number(v[ix.last_year])||0;
  const games=Number(v[ix.career_games])||0;
  const status=v[ix.status]||'retired';
  const keep=lastYear>=2008 && (games>=150 || (status==='active'&&games>=80) || STAR_NAMES.has(name));
  if(!keep)continue;
  pool.push({name,dobKey:v[ix.dob_key]||'',lastYear,status});
}

const indexByDob=new Map();
for(const rec of Object.values(index.players||{})){
  if(!rec?.dobKey)continue;
  if(!indexByDob.has(rec.dobKey))indexByDob.set(rec.dobKey,[]);
  indexByDob.get(rec.dobKey).push(rec);
}
function findIndexRec(p){
  const exact=index.players?.[identity(p.name,p.dobKey)];
  if(exact)return exact;
  const xs=indexByDob.get(p.dobKey)||[];
  return xs.find(x=>nameMatch(x.name,p.name))||null;
}

const output={
  generated:new Date().toISOString(),
  sourcePriority:"AFL.com.au primary; these are verified fallbacks only when the primary image fails.",
  testedPlayers:pool.length,
  brokenPrimary:0,
  verifiedOverrides:0,
  players:{}
};

let next=0;
const concurrency=8;
const workers=Array.from({length:concurrency},async()=>{
  while(next<pool.length){
    const n=next++;
    const p=pool[n];
    const rec=findIndexRec(p);
    const primary=rec?.photoURL||'';
    const ok=primary?await imageWorks(primary):false;
    if(ok){
      if((n+1)%50===0)console.log('Checked',n+1,'/',pool.length);
      continue;
    }
    output.brokenPrimary++;
    const backup=await verifiedBackup(p.name,p.dobKey);
    if(backup){
      output.players[identity(p.name,p.dobKey)]={
        name:p.name,
        dobKey:p.dobKey,
        url:backup.url,
        source:backup.source,
        failedAflPhoto:primary
      };
      output.verifiedOverrides++;
      console.log('Override',p.name,backup.source);
    }else{
      console.log('No verified backup',p.name);
    }
  }
});
await Promise.all(workers);

await fs.writeFile(OUTPUT,JSON.stringify(output,null,2)+'\n');
console.log(JSON.stringify({
  tested:output.testedPlayers,
  brokenPrimary:output.brokenPrimary,
  overrides:output.verifiedOverrides
},null,2));
