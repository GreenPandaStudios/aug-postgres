import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyCandidateWorkflow,readAssociatedRequests} from './candidate-workflow.mjs';

const repository='GreenPandaStudios/aug-postgres';
const head='59c00c51cc6a4be21e87feb35f95618803a43995',base='dc45a85f4b311cc2e9736f66a0459afed34ee157',source='1c96f47bea0bd45bff83cf97b4458d8a007fb5e8';
const plan={format:1,version:'0.2.0',runId:37521907539,workflowHeadRevision:head,sourceRevision:source};
const run={id:plan.runId,repository:{full_name:repository},path:'.github/workflows/candidate.yml',
 status:'completed',conclusion:'success',event:'pull_request',head_sha:head,
 pull_requests:[{head:{sha:head,repo:{url:'https://api.github.com/repos/'+repository}},
 base:{sha:base,repo:{url:'https://api.github.com/repos/'+repository}}}]};
const checkout={sha:source,parents:[{sha:base},{sha:head}]};

test('retained pull-request artifacts bind both the workflow head and actual merge checkout',()=>{
 assert.doesNotThrow(()=>verifyCandidateWorkflow(run,plan,repository,checkout));
 assert.throws(()=>verifyCandidateWorkflow(run,{...plan,sourceRevision:head},repository,checkout),/checkout revision differs/);
 assert.throws(()=>verifyCandidateWorkflow(run,{...plan,workflowHeadRevision:source},repository,checkout),/workflow head differs/);
 assert.throws(()=>verifyCandidateWorkflow(run,plan,repository,{...checkout,parents:[{sha:base},{sha:'a'.repeat(40)}]}),/recorded base and workflow head/);
 assert.throws(()=>verifyCandidateWorkflow({...run,event:'push'},plan,repository,checkout),/pull-request build/);
 assert.throws(()=>verifyCandidateWorkflow({...run,pull_requests:[...run.pull_requests,...run.pull_requests]},plan,repository,checkout),/ambiguous pull request/);
 assert.throws(()=>verifyCandidateWorkflow({...run,pull_requests:[{...run.pull_requests[0],head:{sha:head,repo:{url:'https://api.github.com/repos/other/package'}}}]},plan,repository,checkout),/ambiguous pull request/);
});

test('publication rejects stale, incomplete and unrelated workflows before uploading',()=>{
 for(const change of [{id:1},{repository:{full_name:'other/package'}},{path:'.github/workflows/other.yml'},
 {status:'in_progress'},{conclusion:'failure'},{head_sha:'b'.repeat(40)}]){
   assert.throws(()=>verifyCandidateWorkflow({...run,...change},plan,repository,checkout));
 }
 assert.throws(()=>verifyCandidateWorkflow(run,{...plan,workflowHeadRevision:undefined},repository,checkout));
 assert.doesNotThrow(()=>verifyCandidateWorkflow({...run,event:'push',head_sha:head},
  {...plan,sourceRevision:head},repository,{sha:head,parents:[{sha:base}]}));
});

test('completed merged candidates retain exact commit and parent provenance after GitHub clears run associations',()=>{
 const merged={...run.pull_requests[0],number:1,state:'closed',merged_at:'2026-10-06T20:46:46Z',
   head:{...run.pull_requests[0].head,sha:'c'.repeat(40)}};
 const completed={...run,pull_requests:[]};
 assert.throws(()=>verifyCandidateWorkflow(completed,plan,repository,checkout),/ambiguous pull request/);
 assert.doesNotThrow(()=>verifyCandidateWorkflow(completed,plan,repository,checkout,[merged]));
 for(const request of [
   {...merged,state:'open'}, {...merged,merged_at:null},
   {...merged,base:{...merged.base,sha:'d'.repeat(40)}},
   {...merged,head:{...merged.head,repo:{url:'https://api.github.com/repos/other/package'}}}
 ])assert.throws(()=>verifyCandidateWorkflow(completed,plan,repository,checkout,[request]),/ambiguous pull request/);
 assert.throws(()=>verifyCandidateWorkflow(completed,plan,repository,checkout,[merged,merged]),/ambiguous pull request/);
 assert.throws(()=>verifyCandidateWorkflow(completed,plan,repository,{...checkout,parents:[{sha:base},{sha:merged.head.sha}]},[merged]),/recorded base and workflow head/);
 assert.throws(()=>verifyCandidateWorkflow({...completed,head_sha:merged.head.sha},plan,repository,checkout,[merged]),/workflow head differs/);
});

test('association transport consumes all pages and never accepts hidden ambiguity',()=>{
 const merged={...run.pull_requests[0],number:1,state:'closed',merged_at:'2026-10-06T20:46:46Z'};
 const next={...merged,number:2},completed={...run,pull_requests:[]};
 let args;
 const requests=readAssociatedRequests(value=>{args=value;return JSON.stringify([[merged],[next]]);},repository,head);
 assert.deepEqual(args,['api','--paginate','--slurp','repos/'+repository+'/commits/'+head+'/pulls?per_page=100']);
 assert.throws(()=>verifyCandidateWorkflow(completed,plan,repository,checkout,requests),/ambiguous pull request/);
 for(const pages of [[],{},[{}],Array.from({length:11},()=>[]),[[merged],[merged]]])
   assert.throws(()=>readAssociatedRequests(()=>JSON.stringify(pages),repository,head));
 assert.doesNotThrow(()=>verifyCandidateWorkflow(completed,plan,repository,checkout,
   readAssociatedRequests(()=>JSON.stringify([[merged]]),repository,head)));
});
