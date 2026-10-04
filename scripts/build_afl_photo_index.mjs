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
const wantedDobs=new Set();
for(let i=1;i<masterLines.length;i++){
  if(!masterLines[i].trim())continue;
  const v=csvCells(masterLines[i]);
  const lastYear=Number(v[masterIx.last_year])||0;
  if(lastYear>=2008&&v[masterIx.dob_key])wantedDobs.add(v[masterIx.dob_key]);
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
    if(!dk||!wantedDobs.has(dk))continue;
    const name=((p.firstName||'')+' '+(p.surname||'')).trim();
    if(!name)continue;
    const key=identity(name,dk);
    const providerId=p.providerId||'';
    const champId=String(providerId).replace(/^CD_I/,'');
    const prev=out.players[key]||{};
    out.players[key]={
      name,
      dobKey:dk,
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

await fs.mkdir('data',{recursive:true});
await fs.writeFile('data/afl_photo_index.json',JSON.stringify(out,null,2)+'\n');
console.log('Wrote',Object.keys(out.players).length,'player identities');
