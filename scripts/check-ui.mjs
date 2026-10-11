import { readdirSync,readFileSync } from 'node:fs';
import { join } from 'node:path';
function files(dir){return readdirSync(dir,{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?files(join(dir,entry.name)):[join(dir,entry.name)]);}
const violations=[];
for(const file of files('apps/web/app').concat(files('apps/web/components'))){
 if(!/\.(tsx|css)$/.test(file)||file.includes('app\\styles')||file.includes('app/styles'))continue;
 const content=readFileSync(file,'utf8');
 if(/#[a-f\d]{3,8}\b|\b(?:rgba?|hsla?|oklch)\(/i.test(content))violations.push(file);
}
if(violations.length)throw new Error('Use semantic tokens instead of colour literals: '+violations.join(', '));
console.log('UI colour guard passed.');
