import {readFileSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {gzipSync} from 'node:zlib';
const root='apps/web/.next';const {pages}=JSON.parse(readFileSync(join(root,'app-build-manifest.json'),'utf8'));
let failed=false;
for(const [route,files] of Object.entries(pages)){
 if(!route.endsWith('/page')||route.includes('/dev/')||route.includes('_not-found'))continue;
 const entry=[...new Set([...files,...pages['/layout'],...pages['/error']])].filter(file=>file.endsWith('.js'));
 const bytes=entry.reduce((sum,file)=>sum+gzipSync(readFileSync(join(root,file))).length,0);
 const budget=route==='/page'?110:170;
 console.log(`${route}: ${(bytes/1024).toFixed(1)} KiB initial JS (budget ${budget} KiB)`);
 if(bytes>budget*1024)failed=true;
}
const css=readdirSync(join(root,'static/css')).filter(file=>file.endsWith('.css')).reduce((sum,file)=>sum+gzipSync(readFileSync(join(root,'static/css',file))).length,0);
console.log(`Total CSS: ${(css/1024).toFixed(1)} KiB gzip (budget 45 KiB)`);
if(css>45*1024)failed=true;
if(failed)throw new Error('UI bundle budget exceeded');
