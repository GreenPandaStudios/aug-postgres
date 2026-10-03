import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {existsSync,readFileSync,readdirSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');

/** Identity of reviewed binding/build inputs, excluding measured artifact pins. */
export function nativeSourceIdentity(root){
  root=resolve(root);const manifest=JSON.parse(readFileSync(join(root,'aug-package.json')));
  const files={'native.abi.json':sha(readFileSync(join(root,'native.abi.json')))};
  const walk=(directory,prefix)=>{for(const entry of readdirSync(directory,{withFileTypes:true})){
    if(['target','licenses','aug.lock.json'].includes(entry.name)||entry.name.startsWith('.'))continue;
    const path=join(directory,entry.name),name=prefix+'/'+entry.name;
    assert.ok(!entry.isSymbolicLink(),'Native build inputs must not be symbolic links: '+name);
    if(entry.isDirectory())walk(path,name);
    else if(entry.isFile()&&(/\.(?:c|cc|cpp|h|hpp|rs|mjs|json|toml|yaml|aug)$/.test(entry.name)||['Cargo.lock','Dockerfile'].includes(entry.name)))files[name]=sha(readFileSync(path));
  }};
  walk(join(root,'native'),'native');walk(join(root,manifest.source),manifest.source);walk(join(root,'tests'),'tests');walk(join(root,'http-tests'),'http-tests');
  files['package-contract']=sha(Buffer.from(JSON.stringify({name:manifest.name,version:manifest.version,compiler:manifest.compiler,source:manifest.source,profile:manifest.native.profile,bindings:manifest.native.bindings,bindingsSha256:manifest.native.bindingsSha256,upstream:manifest.native.upstream})));
  const sorted=Object.fromEntries(Object.entries(files).sort(([a],[b])=>a.localeCompare(b)));
  let revision=process.env.AUG_PACKAGE_SOURCE_REVISION;
  if(!revision&&existsSync(join(root,'.git'))){const result=spawnSync(process.env.AUG_GIT??'git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'});if(result.status===0)revision=result.stdout.trim();}
  if(revision)assert.match(revision,/^[0-9a-f]{40,64}$/,'Build checkout revision must be a full source identity');
  return {format:1,revision,revisionRole:revision?'build-checkout':undefined,filesSha256:sha(Buffer.from(JSON.stringify(sorted))),files:sorted};
}

/** Run before tagging: metadata edits must preserve the measured source inputs. */
export function verifyNativeCandidate(candidate,root){
  const current=nativeSourceIdentity(root);
  assert.equal(candidate.source?.format,1,'Candidate is missing its complete source identity');
  assert.equal(current.filesSha256,candidate.source.filesSha256,'Native source/header/descriptor/recipe changed after this candidate was built');
  assert.deepEqual(current.files,candidate.source.files,'Native build input file set changed');
  const manifest=JSON.parse(readFileSync(join(root,'aug-package.json')));
  assert.equal(candidate.package,manifest.name);assert.equal(candidate.version,manifest.version);
  return current;
}
