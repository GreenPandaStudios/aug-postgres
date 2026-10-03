#!/usr/bin/env node
// A source-only compatibility release may reuse bytes from one immutable native release.
import assert from 'node:assert/strict';
import {readFileSync,readdirSync,existsSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const manifest=JSON.parse(readFileSync('aug-package.json')),repository=process.env.GITHUB_REPOSITORY,tag=process.env.AUG_RELEASE_TAG;
assert.equal(repository,'GreenPandaStudios/'+manifest.name.split('/').at(-1));assert.equal(tag,'v'+manifest.version);
const gh=args=>{const result=spawnSync('gh',args,{encoding:'utf8'});assert.equal(result.status,0,result.stderr);return result.stdout;};
const origins=new Set(manifest.native.artifacts.map(a=>{
 const url=new URL(a.url);assert.equal(url.hostname,'github.com');
 const match=url.pathname.match(/^\/GreenPandaStudios\/aug-[\w-]+\/releases\/download\/(v\d+\.\d+\.\d+)\/native-[\w-]+\.tar\.gz$/);assert.ok(match);return match[1];
}));assert.equal(origins.size,1);const originalTag=[...origins][0];assert.notEqual(tag,originalTag);
const originalFile=path=>Buffer.from(JSON.parse(gh(['api',`repos/${repository}/contents/${path}?ref=${originalTag}`])).content,'base64');
const original=JSON.parse(originalFile('aug-package.json'));
assert.deepEqual(manifest.native,original.native,'Source-only releases must preserve every native contract and artifact pin');
const files=['native.abi.json','native/sources.lock.json'];
function collect(directory){for(const entry of readdirSync(directory,{withFileTypes:true})){
 if(entry.name==='licenses'||entry.name.startsWith('.')||entry.name==='target')continue;
 const path=join(directory,entry.name);if(entry.isDirectory())collect(path);else if(/\.(?:c|cc|cpp|rs|h|hpp)$/.test(path))files.push(path);
}}collect('native');
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
for(const file of files)assert.equal(digest(readFileSync(file)),digest(originalFile(file)),'Native input changed: '+file);
const previous=JSON.parse(gh(['api',`repos/${repository}/releases/tags/${originalTag}`]));assert.equal(previous.draft,false);
for(const artifact of manifest.native.artifacts){const filename=new URL(artifact.url).pathname.split('/').at(-1);assert.ok(previous.assets.some(a=>a.name===filename&&a.size===artifact.maximumDownloadBytes),'The inherited artifact must be published');}
const notes=`This source package targets August ${manifest.compiler}. Its native ABI, adapter source and all artifact pins are unchanged from ${originalTag}. Consumers download those existing verified archives. The matching compiler preview is prepared separately; this is a source compatibility release, not a new native binary build.\n`;
writeFileSync('.aug-build/source-release-notes.md',notes);
const releases=JSON.parse(gh(['api',`repos/${repository}/releases?per_page=100`]));
if(!releases.some(r=>r.tag_name===tag))gh(['release','create',tag,'--verify-tag','--prerelease','--title',manifest.name+' '+manifest.version,'--notes-file','.aug-build/source-release-notes.md']);
console.log('Verified unchanged native artifacts from '+originalTag+' for '+tag);
