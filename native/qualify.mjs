#!/usr/bin/env node
// Run only against disposable infrastructure supplied by the maintainer.
import assert from 'node:assert/strict';
import {mkdirSync,readFileSync,writeFileSync,copyFileSync,mkdtempSync,rmSync} from 'node:fs';
import {resolve,join,basename,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {nativeSourceIdentity,verifyNativeCandidate} from './source-identity.mjs';
import {archivedLibrary,verifyArchivedLibraryEvidence} from './archive-library.mjs';
const root=resolve(import.meta.dirname,'..'),mac=process.platform==='darwin';
const directory=join(root,'.aug-build',mac?'native':'native-linux-'+process.arch);
mkdirSync(directory,{recursive:true});
writeFileSync(join(directory,'qualification.json'),JSON.stringify({format:1,status:'running',nativePassed:false,llvmPassed:false})+'\n');
const candidate=JSON.parse(readFileSync(join(directory,'candidate.json')));verifyNativeCandidate(candidate,root);
const configuration=process.env.AUG_POSTGRES_TEST_CONFIGURATION,tls=process.env.AUG_POSTGRES_TEST_TLS_CONFIGURATION;
assert.ok(configuration&&tls,'Supply disposable plaintext and verify-full TLS configurations; qualification never selects an application database.');
const cc=process.env.AUG_CC??(mac?'/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin/clang':'clang');
const archive=join(directory,'native-'+candidate.artifact.id+'.tar.gz');
const acceptedLibrary=archivedLibrary(archive,candidate.artifact);
const verified=join(directory,'verified-artifact');rmSync(verified,{recursive:true,force:true});mkdirSync(join(verified,'lib'),{recursive:true});
const binary=join(directory,'client'),library=join(verified,acceptedLibrary.libraryPath);
writeFileSync(library,acceptedLibrary.bytes);
const nativeEnvironment={...process.env,DYLD_LIBRARY_PATH:'',LD_LIBRARY_PATH:''};
const run=(command,args,env=process.env)=>{const result=spawnSync(command,args,{cwd:root,env,encoding:'utf8',timeout:30000});assert.equal(result.status,0,(result.stderr||result.error?.message||'').slice(-3000));return result.stdout;};
run(cc,[...(mac?['-isysroot',process.env.SDKROOT??'/Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk']:['-Wl,--export-dynamic']),'-std=c11','-D_POSIX_C_SOURCE=200809L','-Wall','-Wextra','-Werror','-pthread','-I'+join(root,'native/include'),join(root,'native/tests/client.c'),library,'-Wl,-rpath,'+(mac?'@loader_path/verified-artifact/lib':'$ORIGIN/verified-artifact/lib'),'-o',binary]);
const results=[];
for(const [name,config,mode] of [['plaintext',configuration],['TLS verify-full',tls],['TLS wrong hostname',tls+' host=wrong.invalid','reject-connect'],['TLS missing trust root',tls+' sslrootcert=/nonexistent/aug-qualification-root.pem','reject-connect']]){
 const started=performance.now(),output=run(binary,[config,...(mode?[mode]:[])],nativeEnvironment);assert.match(output,mode?/rejected without leaks/:/cleanup passed/);results.push({name,passed:true,milliseconds:performance.now()-started});
}
// Resolve the adapter from a new loader-relative directory, without its build tree.
const moved=mkdtempSync(join(tmpdir(),'aug-postgres-relocation-'));
try{const lib=join(moved,'verified-artifact/lib');mkdirSync(lib,{recursive:true});copyFileSync(library,join(lib,basename(library)));copyFileSync(binary,join(moved,'client'));
 const output=run(join(moved,'client'),[tls],{...process.env,DYLD_LIBRARY_PATH:'',LD_LIBRARY_PATH:''});assert.match(output,/cleanup passed/);results.push({name:'isolated library relocation',passed:true});
}finally{rmSync(moved,{recursive:true,force:true});}
const cli=process.env.AUG_CLI;
let compiler,verifyCompiler=()=>{};
if(cli){
 const compilerRoot=dirname(dirname(resolve(cli)));
 const {qualificationIdentity}=await import(pathToFileURL(join(compilerRoot,'scripts/qualification-identity.mjs')));
 const pin=JSON.parse(readFileSync(join(root,'native/compiler-qualification.json')));
 compiler=qualificationIdentity(compilerRoot);
 const {runtimeSourceIdentity}=await import(pathToFileURL(join(compilerRoot,'scripts/runtime-pack-identity.mjs')));
 const runtimeRoot=process.env.AUG_RUNTIME_PACK??join(compilerRoot,'.aug-native/llvm/runtime');
 const runtime=JSON.parse(readFileSync(join(runtimeRoot,'runtime.json')));
 assert.equal(runtimeSourceIdentity(compilerRoot,runtimeRoot,Object.keys(runtime.files)),runtime.sourceSha256,'Compiler runtime pack is stale');
 compiler.runtimeSha256=runtime.sourceSha256;
 if(compiler.sourceSha256===pin.sourceSha256&&compiler.compiler===pin.compiler)compiler.approvedRevision=pin.revision;
 if(process.env.AUG_REQUIRE_QUALIFIED_COMPILER==='1')assert.equal(compiler.approvedRevision,pin.revision,'Package publication needs the pinned checked compiler sources');
 verifyCompiler=()=>assert.equal(qualificationIdentity(compilerRoot).sourceSha256,compiler.sourceSha256,'Compiler sources changed during qualification');
}

if(cli){const cache=join(directory,'consumer-cache'),destination=join(cache,candidate.artifact.sha256);process.env.AUG_NATIVE_ARTIFACT_CACHE=cache;run(process.execPath,[cli,'package','cache-native',root,'--artifact',candidate.artifact.id,'--archive',archive]);assert.equal(createHash('sha256').update(readFileSync(join(destination,acceptedLibrary.libraryPath))).digest('hex'),acceptedLibrary.librarySha256,'LLVM cache library differs from the tested archive');process.env.AUG_NATIVE_ARTIFACT_CACHE=cache;const testRoot=join(root,'tests');run(process.execPath,[cli,'install',testRoot]);run(process.execPath,[cli,'build',testRoot,'--backend','llvm']);const started=performance.now();const output=run(join(testRoot,'.aug-build/tests'),[tls],{...process.env,AUG_WORKERS:'2'});assert.equal(output,'PostgreSQL native worker passed\nPostgreSQL worker cancellation passed\n');assert.ok(performance.now()-started<3000,'Cancellation must finish before the five-second query completes');results.push({name:'LLVM worker ownership and real cancellation',passed:true,milliseconds:performance.now()-started});const http=run(process.execPath,[join(root,'native/qualify-http.mjs')],{...process.env,AUG_POSTGRES_NATIVE_CLIENT:binary});assert.match(http,/cancellation and drain passed/);results.push({name:'HTTP drain joins native database workers',passed:true});}
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
verifyNativeCandidate(candidate,root);verifyCompiler();
assert.equal(sha(readFileSync(library)),acceptedLibrary.librarySha256,'Native library changed during qualification');
verifyArchivedLibraryEvidence(archive,candidate.artifact,acceptedLibrary);
const report={format:1,status:'passed',target:candidate.artifact.target,artifactSha256:candidate.artifact.sha256,libraryPath:acceptedLibrary.libraryPath,librarySha256:acceptedLibrary.librarySha256,source:nativeSourceIdentity(root),server:'PostgreSQL 18.6',nativePassed:true,llvmPassed:!!cli,compiler,results};
writeFileSync(join(directory,'qualification.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({nativePassed:true,llvmPassed:!!cli,results}));
