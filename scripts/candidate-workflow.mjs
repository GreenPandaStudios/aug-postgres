import assert from 'node:assert/strict';

/** Check workflow provenance separately from a pull request's merge checkout. */
export function verifyCandidateWorkflow(run,plan,repository,checkout,associatedRequests=[]) {
  for(const field of ['sourceRevision','workflowHeadRevision'])assert.match(plan[field],/^[0-9a-f]{40}$/,'The release plan must pin '+field);
  assert.equal(run.id,plan.runId,'Candidate workflow id differs');
  assert.equal(run.repository.full_name,repository,'Candidate workflow belongs to another repository');
  assert.equal(run.path,'.github/workflows/candidate.yml','Candidate workflow path differs');
  assert.equal(run.status,'completed');assert.equal(run.conclusion,'success');
  assert.equal(run.head_sha,plan.workflowHeadRevision,'Candidate workflow head differs');
  assert.equal(checkout.sha,plan.sourceRevision,'Candidate checkout revision differs');
  if(plan.sourceRevision===plan.workflowHeadRevision)return;
  assert.equal(run.event,'pull_request','A distinct checkout revision requires a pull-request build');
  assert.ok(Array.isArray(run.pull_requests),'Workflow pull-request associations are missing');
  const requests=run.pull_requests.length?run.pull_requests.filter(request=>request.head.sha===plan.workflowHeadRevision
    &&request.head.repo.url==='https://api.github.com/repos/'+repository
    &&request.base.repo.url==='https://api.github.com/repos/'+repository):associatedRequests.filter(request=>
      request.state==='closed'&&request.merged_at&&request.base.sha===checkout.parents[0]?.sha
      &&request.head.repo.url==='https://api.github.com/repos/'+repository
      &&request.base.repo.url==='https://api.github.com/repos/'+repository);
  // GitHub removes run.pull_requests after merge. associatedRequests must come
  // from its exact /commits/<workflowHeadRevision>/pulls endpoint, not an arbitrary PR.
  assert.equal(requests.length,1,'Candidate merge checkout has an ambiguous pull request');
  assert.deepEqual(checkout.parents.map(parent=>parent.sha),[requests[0].base.sha,plan.workflowHeadRevision],
    'Candidate checkout must merge the recorded base and workflow head');
}

/** Retrieve the complete official association set; truncated or malformed input fails. */
export function readAssociatedRequests(gh,repository,revision) {
  assert.match(repository,/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
  assert.match(revision,/^[0-9a-f]{40}$/);
  const pages=JSON.parse(gh(['api','--paginate','--slurp','repos/'+repository+'/commits/'+revision+'/pulls?per_page=100']));
  assert.ok(Array.isArray(pages)&&pages.length>0&&pages.length<=10,'Association coverage exceeds the bounded protocol');
  const requests=[];
  for(const page of pages) {
    assert.ok(Array.isArray(page)&&page.length<=100,'Association page is invalid');
    requests.push(...page);
  }
  const numbers=new Set();
  for(const request of requests) {
    assert.ok(Number.isSafeInteger(request.number)&&request.number>0&&!numbers.has(request.number),'Association pages repeat or omit a request identity');
    numbers.add(request.number);
  }
  return requests;
}
