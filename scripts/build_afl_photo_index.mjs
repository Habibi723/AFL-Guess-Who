import fs from 'node:fs/promises';

const API='https://aflapi.afl.com.au/afl/v2/';
const START=2008, END=2026;

const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function getJson(url, tries=4){
  let last;
  for(let i=0;i<tries;i++){
    try{
      const r=await fetch(url,{headers:{'user-agent':'AFL-Guess-Who-photo-index/1.0'}});
      if(r.ok)return await r.json();
      last=new Error('HTTP '+r.status+' '+url);
    }catch(e){last=e;}
    await sleep(600*(i+1));
  }
  throw last;
}
const norm=s=>String(s||'').toLowerCase().replace(/[^a-z0-9]/g,'');
const dobKey=iso=>{
  const m=String(iso||'').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m?m[3]+m[2]+m[1]:'';
};
const identity=(name,dob)=>norm(name)+'|'+dob;

function csvCells(line){
  const out=[];let cur='';let q=false;
  for(let i=0;i<line.length;i++){
    const ch=line[i];
    if(ch==='"'){
      if(q&&line[i+1]==='"'){cur+='"';i++}else q=!q;
    }else if(ch===','&&!q){
      out.push(cur);cur='';
    }else cur+=ch;
  }
  out.push(cur);return out;
}

const masterText=await fs.readFile('data/player_status.csv','utf8');
const masterLines=masterText.trim().split(/\r?\n/);
const masterHead=csvCells(masterLines[0]);
const masterIx=Object.fromEntries(masterHead.map((h,i)=>[h,i]));
const MODERN_STAR_NAMES=new Set([
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
const titleWord=s=>String(s||'').split(/([-'])/).map(part=>{
  if(part==='-'||part==="'")return part;
  return part?part.charAt(0).toUpperCase()+part.slice(1):part;
}).join('');

const wantedDobs=new Set();
const masterRecords=[];
for(let i=1;i<masterLines.length;i++){
  if(!masterLines[i].trim())continue;
  const v=csvCells(masterLines[i]);
  const lastYear=Number(v[masterIx.last_year])||0;
  const careerGames=Number(v[masterIx.career_games])||0;
  const status=v[masterIx.status]||'';
  const dk=v[masterIx.dob_key]||'';
  const first=v[masterIx.first_name]||'';
  const last=v[masterIx.last_name]||'';
  const name=(titleWord(first)+' '+titleWord(last)).trim();
  const keep=lastYear>=2008 && (
    careerGames>=150 ||
    (status==='active'&&careerGames>=80) ||
    MODERN_STAR_NAMES.has(name)
  );
  if(!keep||!dk)continue;
  wantedDobs.add(dk);
  masterRecords.push({name,first,last,dobKey:dk,lastYear,careerGames,status});
}

const masterByNormName=new Map();
const masterByFirstLast=new Map();
const firstToken=s=>norm(String(s||'').trim().split(/\s+/)[0]||'');
const lastToken=s=>norm(String(s||'').trim().split(/\s+/).pop()||'');
for(const m of masterRecords){
  const nk=norm(m.name);
  if(!masterByNormName.has(nk))masterByNormName.set(nk,[]);
  masterByNormName.get(nk).push(m);
  const fl=norm(m.first)+'|'+norm(m.last);
  if(!masterByFirstLast.has(fl))masterByFirstLast.set(fl,[]);
  masterByFirstLast.get(fl).push(m);
}

const compsJson=await getJson(API+'competitions');
const comps=Array.isArray(compsJson)?compsJson:(compsJson.competitions||[]);
const aflComp=comps.find(x=>x.code==='AFL'||x.code==='AFLM'||x.id===1)||comps[0];
if(!aflComp?.id)throw new Error('Could not resolve AFL competition');

const seasonsJson=await getJson(API+'competitions/'+aflComp.id+'/compseasons');
const seasons=Array.isArray(seasonsJson)?seasonsJson:(seasonsJson.compSeasons||[]);
const seasonByYear=new Map();
for(const s of seasons){
  let year=null;
  let m=String(s.providerId||'').match(/^CD_S(\d{4})/);
  if(m)year=Number(m[1]);
  if(!year){m=String(s.name||'').match(/^(\d{4})/); if(m)year=Number(m[1]);}
  if(year&&s.id)seasonByYear.set(year,s.id);
}

const out={generated:new Date().toISOString(),source:'afl.com.au public AFL API season squad photoURL',players:{}};

async function mapPool(items,limit,fn){
  let next=0;
  const workers=Array.from({length:limit},async()=>{
    while(next<items.length){
      const item=items[next++];
      try{await fn(item)}catch(e){console.warn(String(e));}
    }
  });
  await Promise.all(workers);
}

for(let year=START;year<=END;year++){
  const sid=seasonByYear.get(year);
  if(!sid){console.log('No comp season for',year);continue;}
  console.log('Season',year,'id',sid);

  const teamsJson=await getJson(API+'teams?compSeasonId='+sid+'&pageSize=100');
  const teams=(teamsJson.teams||[]).filter(t=>!t.teamType||t.teamType==='MEN');
  await mapPool(teams,6,async team=>{
    const j=await getJson(API+'squads?teamId='+team.id+'&compSeasonId='+sid);
    for(const row of (j.squad?.players||[])){
      const p=row.player||{};
      const name=((p.firstName||'')+' '+(p.surname||'')).trim();
      if(!name)continue;
      const key=identity(name,dobKey(p.dateOfBirth));
      const providerId=p.providerId||'';
      const champId=String(providerId||'').replace(/^CD_I/,'');
      const returnedPhotoURL=p.photoURL||row.photoURL||'';
      const derivedAflPhotoURL=champId
        ? 'https://s.afl.com.au/staticfile/AFL%20Tenant/AFL/Players/ChampIDImages/AFL/'+year+'014/'+champId+'.png?im=Scale,width=0.6,height=0.6'
        : '';
      const photoURL=returnedPhotoURL||derivedAflPhotoURL;
      const prev=out.players[key];
      const rec={
        name,
        dobKey:dobKey(p.dateOfBirth),
        photoURL:photoURL||prev?.photoURL||'',
        providerId:providerId||prev?.providerId||'',
        champId:champId||String(prev?.providerId||'').replace(/^CD_I/,''),
        aflProfileId:p.id||prev?.aflProfileId||null,
        team:j.squad?.team?.name||team.name||prev?.team||'',
        season:year
      };
      // Later seasons win, but never erase a previously found photo.
      out.players[key]=rec;
    }
  });
}


// Fill older-player identities from the AFL all-time catalogue.
// We only retain DOBs that appear in our 2008+ source database, keeping the file compact.
let page=0;
let numPages=1;
const pageSize=300;
while(page<numPages){
  const j=await getJson(API+'players?page='+page+'&pageSize='+pageSize);
  const players=j.players||[];
  const pg=j.meta?.pagination||{};
  numPages=Number(pg.numPages)||Math.ceil((Number(pg.numEntries)||17403)/(Number(pg.pageSize)||pageSize));
  for(const p of players){
    const dk=dobKey(p.dateOfBirth);
    const officialName=((p.firstName||'')+' '+(p.surname||'')).trim();
    if(!officialName)continue;

    let candidates=masterByNormName.get(norm(officialName))||[];
    if(!candidates.length){
      const fl=norm(p.firstName)+'|'+lastToken(p.surname);
      candidates=masterByFirstLast.get(fl)||[];
    }
    if(!candidates.length)continue;

    // Prefer exact DOB, otherwise birth-year match, otherwise a unique name match.
    let matches=candidates;
    if(dk){
      const exactDob=candidates.filter(m=>m.dobKey===dk);
      if(exactDob.length)matches=exactDob;
      else{
        const y=dk.slice(-4);
        const sameYear=candidates.filter(m=>String(m.dobKey||'').slice(-4)===y);
        if(sameYear.length)matches=sameYear;
      }
    }
    if(matches.length!==1)continue;

    const m=matches[0];
    const key=identity(m.name,m.dobKey);
    const providerId=p.providerId||'';
    const champId=String(providerId).replace(/^CD_I/,'');
    const prev=out.players[key]||{};
    out.players[key]={
      name:m.name,
      officialName,
      dobKey:m.dobKey,
      photoURL:prev.photoURL||'',
      providerId:providerId||prev.providerId||'',
      champId:champId||prev.champId||'',
      aflProfileId:p.id||prev.aflProfileId||null,
      team:prev.team||'',
      season:prev.season||null,
      debutYear:p.debutYear||prev.debutYear||null
    };
  }
  page++;
}


// Alias official AFL catalogue names back to the names used by the game database.
// This safely handles particles that the source database sometimes drops:
// "Matt de Boer" -> "Matt Boer", "Jordan De Goey" -> "Jordan Goey",
// "Callum Ah Chee" -> "Callum Chee".
const byDob=new Map();
for(const rec of Object.values(out.players)){
  if(!rec?.dobKey)continue;
  if(!byDob.has(rec.dobKey))byDob.set(rec.dobKey,[]);
  byDob.get(rec.dobKey).push(rec);
}
for(const m of masterRecords){
  const gameKey=identity(m.name,m.dobKey);
  let rec=out.players[gameKey];

  if(!rec){
    const candidates=(byDob.get(m.dobKey)||[]).filter(x=>
      firstToken(x.name)===norm(m.first) &&
      lastToken(x.name)===norm(m.last)
    );
    if(candidates.length===1){
      const hit=candidates[0];
      rec={
        ...hit,
        name:m.name,
        officialName:hit.name
      };
      out.players[gameKey]=rec;
    }
  }

  if(rec?.champId){
    const y=Math.max(2008,Math.min(2026,Number(m.lastYear)||2026));
    const primary='https://s.afl.com.au/staticfile/AFL%20Tenant/AFL/Players/ChampIDImages/AFL/'+y+'014/'+rec.champId+'.png?im=Scale,width=0.6,height=0.6';
    if(!rec.photoURL)rec.photoURL=primary;
    rec.lastYear=y;
  }
}



function wikiTitleMatches(title,m){
  const clean=String(title||'').replace(/\([^)]*\)/g,'').trim();
  const exact=norm(clean)===norm(m.name);
  if(exact)return true;
  const parts=clean.split(/\s+/);
  if(parts.length<2)return false;
  const first=norm(parts[0]);
  const last=norm(parts[parts.length-1]);
  const wantedFirst=norm(m.first);
  const wantedLast=norm(m.last);
  return last===wantedLast && (
    first===wantedFirst ||
    first.startsWith(wantedFirst) ||
    wantedFirst.startsWith(first)
  );
}

async function getVerifiedWikiPhoto(m){
  const birthYear=String(m.dobKey||'').slice(-4);
  const terms=[
    '"'+m.name+'" "Australian rules footballer" '+birthYear,
    '"'+m.name+'" AFL '+birthYear
  ];

  for(const term of terms){
    try{
      const url='https://en.wikipedia.org/w/api.php?action=query&format=json&generator=search'
        +'&gsrsearch='+encodeURIComponent(term)
        +'&gsrlimit=5&prop=pageimages&piprop=thumbnail%7Coriginal&pithumbsize=900';
      const j=await getJson(url);
      const pages=Object.values(j.query?.pages||{})
        .filter(p=>wikiTitleMatches(p.title,m))
        .sort((a,b)=>(a.index??999)-(b.index??999));
      for(const p of pages){
        const src=p.thumbnail?.source||p.original?.source||'';
        if(src)return src;
      }
    }catch(e){
      console.warn('Wikipedia image lookup failed for',m.name,String(e));
    }
  }

  // Commons fallback, but only accept filenames containing both the player's
  // first name and surname so we don't attach a random same-surname photo.
  for(const term of terms){
    try{
      const url='https://commons.wikimedia.org/w/api.php?action=query&format=json&generator=search'
        +'&gsrnamespace=6&gsrsearch='+encodeURIComponent(term)
        +'&gsrlimit=8&prop=imageinfo&iiprop=url&iiurlwidth=900';
      const j=await getJson(url);
      const first=norm(m.first);
      const last=norm(m.last);
      for(const p of Object.values(j.query?.pages||{})){
        const file=norm(String(p.title||'').replace(/^File:/i,''));
        if(!file.includes(first)||!file.includes(last))continue;
        const info=p.imageinfo?.[0];
        const src=info?.thumburl||info?.url||'';
        if(src)return src;
      }
    }catch(e){
      console.warn('Commons image lookup failed for',m.name,String(e));
    }
  }
  return '';
}

// Pre-build a verified backup for players that don't have a reliable AFL identity.
// The browser still tries AFL.com.au / AFL Photos first; this is only the safety net.
const missingForFallback=masterRecords.filter(m=>!out.players[identity(m.name,m.dobKey)]);
await mapPool(missingForFallback,6,async m=>{
  const fallbackPhotoURL=await getVerifiedWikiPhoto(m);
  const key=identity(m.name,m.dobKey);
  if(!out.players[key]){
    out.players[key]={
      name:m.name,
      dobKey:m.dobKey,
      photoURL:'',
      fallbackPhotoURL,
      providerId:'',
      champId:'',
      aflProfileId:null,
      team:'',
      season:m.lastYear,
      lastYear:m.lastYear,
      source:fallbackPhotoURL?'verified-wikimedia-fallback':'unresolved'
    };
  }else if(fallbackPhotoURL){
    out.players[key].fallbackPhotoURL=fallbackPhotoURL;
  }
});

// Keep the published index small and exact: only players actually eligible for the game.
const poolPlayers={};
const missing=[];
let withPhoto=0;
let withFallback=0;
for(const m of masterRecords){
  const key=identity(m.name,m.dobKey);
  const rec=out.players[key];
  if(rec){
    poolPlayers[key]=rec;
    if(rec.photoURL)withPhoto++;
    if(rec.fallbackPhotoURL)withFallback++;
  }else{
    missing.push(m.name);
  }
}
out.players=poolPlayers;
out.poolCount=masterRecords.length;
out.matchedCount=Object.keys(poolPlayers).length;
out.photoUrlCount=withPhoto;
out.fallbackPhotoCount=withFallback;

await fs.writeFile('data/afl_photo_index_summary.json',JSON.stringify({
  generated:out.generated,
  poolCount:masterRecords.length,
  matchedCount:Object.keys(poolPlayers).length,
  photoUrlCount:withPhoto,
  fallbackPhotoCount:withFallback,
  coveredByAnyPhoto:withPhoto+withFallback,
  missingCount:missing.length,
  missing
},null,2)+'\n');

await fs.mkdir('data',{recursive:true});
await fs.writeFile('data/afl_photo_index.json',JSON.stringify(out,null,2)+'\n');
console.log('Wrote',Object.keys(out.players).length,'player identities');
