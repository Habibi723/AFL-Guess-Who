import fs from 'node:fs/promises';

const indexPath='data/afl_photo_index.json';
const data=JSON.parse(await fs.readFile(indexPath,'utf8'));
const players=data.players||{};

const norm=s=>String(s||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]/g,'');
const firstToken=s=>norm(String(s||'').trim().split(/\s+/)[0]||'');
const lastToken=s=>norm(String(s||'').trim().split(/\s+/).pop()||'');

const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function getJson(url,tries=2){
  let err;
  for(let i=0;i<tries;i++){
    try{
      const r=await fetch(url,{headers:{'user-agent':'AFL-Guess-Who-photo-gap-builder/1.0'}});
      if(r.ok)return await r.json();
      err=new Error('HTTP '+r.status);
    }catch(e){err=e}
    await sleep(250*(i+1));
  }
  throw err;
}

async function wikidataPhoto(rec){
  const name=rec.name||'';
  const birthYear=String(rec.dobKey||'').slice(-4);
  try{
    const s=await getJson('https://www.wikidata.org/w/api.php?action=wbsearchentities&format=json&language=en&limit=8&origin=*&search='+encodeURIComponent(name+' Australian rules footballer'));
    const matches=(s.search||[]).filter(x=>{
      const label=x.label||'';
      if(norm(label)===norm(name))return true;
      return lastToken(label)===lastToken(name)&&(
        firstToken(label)===firstToken(name)||
        firstToken(label).startsWith(firstToken(name))||
        firstToken(name).startsWith(firstToken(label))
      );
    });
    for(const m of matches){
      const e=await getJson('https://www.wikidata.org/w/api.php?action=wbgetentities&format=json&origin=*&props=claims&ids='+encodeURIComponent(m.id));
      const claims=e.entities?.[m.id]?.claims||{};
      const dob=claims.P569?.[0]?.mainsnak?.datavalue?.value?.time||'';
      if(birthYear&&dob){
        const y=String(dob).match(/^\+?(\d{4})-/)?.[1]||'';
        if(y&&y!==birthYear)continue;
      }
      const file=claims.P18?.[0]?.mainsnak?.datavalue?.value;
      if(file)return 'https://commons.wikimedia.org/wiki/Special:Redirect/file/'+encodeURIComponent(file);
    }
  }catch(e){}
  return '';
}

async function wikipediaPhoto(rec){
  const name=rec.name||'';
  const birthYear=String(rec.dobKey||'').slice(-4);
  const terms=[
    '"'+name+'" "Australian rules footballer" '+birthYear,
    '"'+name+'" AFL '+birthYear
  ];
  for(const q of terms){
    try{
      const j=await getJson('https://en.wikipedia.org/w/api.php?action=query&format=json&origin=*&generator=search&gsrsearch='+encodeURIComponent(q)+'&gsrlimit=6&prop=pageimages&piprop=thumbnail%7Coriginal&pithumbsize=900');
      const pages=Object.values(j.query?.pages||{});
      for(const p of pages){
        const title=String(p.title||'').replace(/\([^)]*\)/g,'').trim();
        const exact=norm(title)===norm(name);
        const plausible=lastToken(title)===lastToken(name)&&(
          firstToken(title)===firstToken(name)||
          firstToken(title).startsWith(firstToken(name))||
          firstToken(name).startsWith(firstToken(title))
        );
        if(!exact&&!plausible)continue;
        const src=p.thumbnail?.source||p.original?.source||'';
        if(src)return src;
      }
    }catch(e){}
  }
  return '';
}


async function getText(url,tries=2){
  let err;
  for(let i=0;i<tries;i++){
    try{
      const r=await fetch(url,{headers:{
        'user-agent':'AFL-Guess-Who-photo-gap-builder/1.1 (player photo verification)'
      }});
      if(r.ok)return {text:await r.text(),url:r.url};
      err=new Error('HTTP '+r.status);
    }catch(e){err=e}
    await sleep(250*(i+1));
  }
  throw err;
}

function decodeHtml(s){
  return String(s||'')
    .replace(/&amp;/g,'&')
    .replace(/&quot;/g,'"')
    .replace(/&#39;/g,"'")
    .replace(/&lt;/g,'<')
    .replace(/&gt;/g,'>');
}

function ogImage(html){
  const patterns=[
    /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i
  ];
  for(const re of patterns){
    const m=String(html||'').match(re);
    if(m?.[1]){
      const src=decodeHtml(m[1]);
      if(!/wikipedia-wordmark|wiki-logo|wikimedia-button/i.test(src))return src;
    }
  }
  return '';
}

function looksLikeCorrectAflPage(html,rec){
  const h=String(html||'');
  const birthYear=String(rec.dobKey||'').slice(-4);
  const lower=h.toLowerCase();
  const afl=/australian rules football|australian football league|\bafl\b/.test(lower);
  const year=!birthYear||lower.includes(birthYear);
  const surname=lastToken(rec.name);
  const hasSurname=norm(h.slice(0,250000)).includes(surname);
  return afl&&year&&hasSurname;
}

async function wikipediaHtmlPhoto(rec){
  const name=rec.name||'';
  const title=name.trim().replace(/\s+/g,'_');
  const direct='https://en.wikipedia.org/wiki/'+encodeURIComponent(title).replace(/%2F/g,'/');
  try{
    const r=await getText(direct);
    if(!looksLikeCorrectAflPage(r.text,rec))return '';

    // Only accept the page's lead/infobox image when the HTML clearly refers to
    // this exact player name. Generic og:image can be another person on the page.
    const exactName=norm(r.text.slice(0,120000)).includes(norm(name));
    if(!exactName)return '';

    const src=ogImage(r.text);
    const fileKey=norm(src);
    const first=firstToken(name), last=lastToken(name);
    if(src && fileKey.includes(first) && fileKey.includes(last))return src;
  }catch(e){}
  return '';
}

async function findPhoto(rec){
  // Structured sources first. HTML is last resort and must pass a strict filename match.
  return await wikidataPhoto(rec)||await wikipediaPhoto(rec)||await wikipediaHtmlPhoto(rec)||'';
}

const targets=Object.entries(players).filter(([,r])=>!r.photoURL&&!r.fallbackPhotoURL);
console.log('Quick gap targets:',targets.length);

let next=0,found=0;
const workers=Array.from({length:10},async()=>{
  while(next<targets.length){
    const [key,rec]=targets[next++];
    const src=await findPhoto(rec);
    if(src){
      players[key].fallbackPhotoURL=src;
      players[key].source='verified-wikimedia-fallback';
      found++;
      console.log('FOUND',rec.name);
    }else{
      console.log('MISS',rec.name);
    }
  }
});
await Promise.all(workers);

data.players=players;
data.quickFallbackGenerated=new Date().toISOString();
await fs.writeFile(indexPath,JSON.stringify(data,null,2)+'\n');

const unresolved=Object.values(players).filter(r=>!r.photoURL&&!r.fallbackPhotoURL).map(r=>r.name);
await fs.writeFile('data/photo_gap_summary.json',JSON.stringify({
  generated:data.quickFallbackGenerated,
  targets:targets.length,
  found,
  unresolvedCount:unresolved.length,
  unresolved
},null,2)+'\n');
console.log('Quick gap found',found,'remaining',unresolved.length);
