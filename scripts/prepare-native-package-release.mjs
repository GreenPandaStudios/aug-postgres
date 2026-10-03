#!/usr/bin/env node
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {copyFileSync,existsSync,mkdirSync,readFileSync,readdirSync,writeFileSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {verifyNativeCandidate} from './native-source-identity.mjs';

export const nativeReleaseTargets=['linux-arm64','linux-x64','macos-arm64'];
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');

/** Recheck staged assets against tagged pins immediately before publication. */
export function verifyNativeReleaseDirectory(root,directory){
  const manifest=JSON.parse(readFileSync(join(root,'aug-package.json')));
  const plan=JSON.parse(readFileSync(join(root,'release-candidates.json')));
  const record=JSON.parse(readFileSync(join(directory,'release.json')));
  assert.equal(record.format,1);assert.equal(record.package,manifest.name);assert.equal(record.version,manifest.version);
  assert.equal(record.sourceRevision,plan.sourceRevision);assert.equal(record.runId,plan.runId);
  const filenames=nativeReleaseTargets.map(id=>'native-'+id+'.tar.gz').sort();
  assert.deepEqual(readdirSync(directory).sort(),['SHA256SUMS',...filenames,'release.json']);
  assert.deepEqual(record.files.map(file=>file.filename).sort(),filenames,'Release metadata must identify every native target exactly once');
  assert.deepEqual(manifest.native.artifacts.map(artifact=>artifact.id).sort(),nativeReleaseTargets);
  for(const file of record.files){
    const artifact=manifest.native.artifacts.find(artifact=>'native-'+artifact.id+'.tar.gz'===file.filename);
    assert.equal(file.sha256,artifact.sha256,'Release digest differs from tagged pins');
    assert.equal(file.size,artifact.maximumDownloadBytes,'Release size differs from tagged pins');
    assert.deepEqual(file.target,artifact.target,'Release target differs from tagged pins');
    assert.equal(file.source.revision,plan.sourceRevision);
    verifyNativeCandidate({source:file.source,package:record.package,version:record.version},root);
    const bytes=readFileSync(join(directory,file.filename));
    assert.equal(bytes.length,artifact.maximumDownloadBytes);assert.equal(digest(bytes),artifact.sha256,'Staged archive differs from tagged pins');
  }
  const checksums=filenames.map(filename=>record.files.find(file=>file.filename===filename).sha256+'  '+filename);
  checksums.push(digest(readFileSync(join(directory,'release.json')))+'  release.json');
  assert.equal(readFileSync(join(directory,'SHA256SUMS'),'utf8'),checksums.join('\n')+'\n','Release checksum file differs');
  return record;
}

/** Assemble reviewed CI outputs without rebuilding or modifying accepted pins. */
export function prepareNativePackageRelease(root,input,output){
  root=resolve(root);input=resolve(input);output=resolve(output);
  const manifest=JSON.parse(readFileSync(join(root,'aug-package.json')));
  const plan=JSON.parse(readFileSync(join(root,'release-candidates.json')));
  assert.equal(plan.format,1);assert.equal(plan.version,manifest.version);
  assert.match(plan.sourceRevision,/^[0-9a-f]{40}$/);
  assert.ok(Number.isSafeInteger(plan.runId)&&plan.runId>0);
  assert.deepEqual(manifest.native.artifacts.map(a=>a.id).sort(),nativeReleaseTargets);
  const candidates=[];
  const walk=directory=>{for(const entry of readdirSync(directory,{withFileTypes:true})){
    const path=join(directory,entry.name);
    assert.ok(!entry.isSymbolicLink(),'Candidate inputs must not contain links');
    if(entry.isDirectory())walk(path);else if(entry.name==='candidate.json')candidates.push(path);
  }};walk(input);
  const selected=new Map();
  for(const path of candidates){
    const candidate=JSON.parse(readFileSync(path));
    verifyNativeCandidate(candidate,root);
    assert.equal(candidate.source.revision,plan.sourceRevision,'Candidate was built from another source revision');
    const artifact=candidate.artifact;
    assert.ok(nativeReleaseTargets.includes(artifact.id),'Unexpected native target');
    assert.ok(!selected.has(artifact.id),'Duplicate native target');
    assert.deepEqual(artifact,manifest.native.artifacts.find(a=>a.id===artifact.id),'Tagged manifest must pin the exact reviewed artifact');
    const qualification=JSON.parse(readFileSync(join(dirname(path),'qualification.json')));
    const compilerPin=JSON.parse(readFileSync(join(root,'native/compiler-qualification.json')));
    assert.equal(qualification.llvmPassed,true,'Real LLVM worker and HTTP database qualification is required');
    assert.equal(qualification.compiler?.compiler,compilerPin.compiler,'LLVM qualification used a different compiler version');
    assert.equal(qualification.compiler?.sourceSha256,compilerPin.sourceSha256,'LLVM qualification used different compiler sources');
    assert.equal(qualification.compiler?.approvedRevision,compilerPin.revision,'LLVM qualification did not identify the reviewed compiler revision');
    assert.equal(qualification.nativePassed,true,'Native database qualification is required');assert.equal(qualification.artifactSha256,artifact.sha256,'Qualification belongs to another artifact');assert.equal(qualification.source.filesSha256,candidate.source.filesSha256,'Qualification source differs');verifyNativeCandidate({source:qualification.source,package:manifest.name,version:manifest.version},root);
    const filename='native-'+artifact.id+'.tar.gz';
    assert.equal(artifact.url,`https://github.com/GreenPandaStudios/${manifest.name.split('/').at(-1)}/releases/download/v${manifest.version}/${filename}`);
    const archive=join(dirname(path),filename),bytes=readFileSync(archive);
    assert.equal(bytes.length,artifact.maximumDownloadBytes,'Candidate archive size differs');
    assert.equal(digest(bytes),artifact.sha256,'Candidate archive digest differs');
    selected.set(artifact.id,{filename,archive,artifact,source:candidate.source});
  }
  assert.deepEqual([...selected.keys()].sort(),nativeReleaseTargets,'A required native candidate is missing');
  // No output is accepted until every candidate, source contract and archive passes.
  mkdirSync(output,{recursive:true});
  const entries=[...selected.values()].sort((a,b)=>a.filename.localeCompare(b.filename));
  for(const item of entries)copyFileSync(item.archive,join(output,item.filename));
  const record={format:1,package:manifest.name,version:manifest.version,sourceRevision:plan.sourceRevision,runId:plan.runId,
    files:entries.map(({filename,artifact,source})=>({filename,sha256:artifact.sha256,size:artifact.maximumDownloadBytes,target:artifact.target,source}))};
  writeFileSync(join(output,'release.json'),JSON.stringify(record,null,2)+'\n');
  const checksums=entries.map(e=>e.artifact.sha256+'  '+e.filename);
  checksums.push(digest(readFileSync(join(output,'release.json')))+'  release.json');
  writeFileSync(join(output,'SHA256SUMS'),checksums.join('\n')+'\n');
  verifyNativeReleaseDirectory(root,output);
  return record;
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
  assert.ok(process.argv[2]&&existsSync(process.argv[2]),'Provide the downloaded native candidate directory');
  console.log(JSON.stringify(prepareNativePackageRelease(process.cwd(),process.argv[2],process.argv[3]??'.aug-build/release')));
}
