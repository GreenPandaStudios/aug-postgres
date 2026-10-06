import assert from 'node:assert/strict';

/** Check workflow provenance separately from a pull request's merge checkout. */
export function verifyCandidateWorkflow(run,plan,repository,checkout) {
  for(const field of ['sourceRevision','workflowHeadRevision'])assert.match(plan[field],/^[0-9a-f]{40}$/,'The release plan must pin '+field);
  assert.equal(run.id,plan.runId,'Candidate workflow id differs');
  assert.equal(run.repository.full_name,repository,'Candidate workflow belongs to another repository');
  assert.equal(run.path,'.github/workflows/candidate.yml','Candidate workflow path differs');
  assert.equal(run.status,'completed');assert.equal(run.conclusion,'success');
  assert.equal(run.head_sha,plan.workflowHeadRevision,'Candidate workflow head differs');
  assert.equal(checkout.sha,plan.sourceRevision,'Candidate checkout revision differs');
  if(plan.sourceRevision===plan.workflowHeadRevision)return;
  assert.equal(run.event,'pull_request','A distinct checkout revision requires a pull-request build');
  const requests=run.pull_requests.filter(request=>request.head.sha===plan.workflowHeadRevision
    &&request.head.repo.url==='https://api.github.com/repos/'+repository
    &&request.base.repo.url==='https://api.github.com/repos/'+repository);
  assert.equal(requests.length,1,'Candidate merge checkout has an ambiguous pull request');
  assert.deepEqual(checkout.parents.map(parent=>parent.sha),[requests[0].base.sha,requests[0].head.sha],
    'Candidate checkout must merge the recorded base and workflow head');
}
